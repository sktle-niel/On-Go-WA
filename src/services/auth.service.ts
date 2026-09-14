import { randomInt } from 'node:crypto';
import { tokensValidFromSeconds, type AuthContext } from '../auth/guard.js';
import { hashPassword, needsRehash, verifyDummyPassword, verifyPassword } from '../auth/password.js';
import {
  createSession,
  findFamilyByRefreshToken,
  revokeFamily,
  revokeUserSessions,
  rotateSession,
} from '../auth/sessions.js';
import { issueAccessToken, verifyAccessToken, type TokenRole } from '../auth/tokens.js';
import {
  displayNameOf,
  findUserByEmail,
  findUserById,
  insertUser,
  isLocked,
  loadPermissions,
  normalizeEmail,
  recordFailedLogin,
  recordSuccessfulLogin,
  updatePassword,
  type Permissions,
  type UserRow,
} from '../auth/users.js';
import type { AppConfig } from '../config/env.js';
import type { CodeDelivery } from '../context.js';
import type { Database } from '../db/database.js';
import { recordLoginAttempt, recordSecurityEvent, SecurityEvent } from '../logging/audit.js';
import { hmacSha256, safeEqual } from '../utils/crypto.js';
import { AppError, conflict, invalidCredentials, isUniqueViolation, unauthorized } from '../utils/errors.js';

/**
 * Sign-in, sessions and passwords.
 *
 * Everything here is written so that a failure reveals as little as possible:
 * unknown accounts and wrong passwords produce the same error in the same
 * time, password resets answer 202 whether or not the email exists, and a
 * surface mismatch is only reported once the password was right.
 */

export type Surface = 'mobile' | 'console';

export interface AuthDeps {
  db: Database;
  config: AppConfig;
  codeDelivery: CodeDelivery;
}

export interface RequestMeta {
  ipHash: Buffer;
  userAgentHash: Buffer | null;
  requestId: string;
}

export interface AuthenticatedUserDto {
  accountId: string;
  displayName: string;
  email: string;
  role: TokenRole;
}

export interface SessionBundle {
  user: AuthenticatedUserDto;
  permissions: Permissions;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  surface: Surface;
}

export function surfaceOf(role: TokenRole): Surface {
  return role === 'admin' || role === 'moderator' ? 'console' : 'mobile';
}

export function toAuthenticatedUser(user: UserRow): AuthenticatedUserDto {
  return { accountId: user.id, displayName: displayNameOf(user), email: user.email, role: user.role };
}

async function openSession(deps: AuthDeps, user: UserRow, meta: RequestMeta): Promise<SessionBundle> {
  const session = await createSession(deps.db, {
    userId: user.id,
    ipHash: meta.ipHash,
    userAgentHash: meta.userAgentHash,
  });
  const access = await issueAccessToken({
    userId: user.id,
    role: user.role,
    sessionFamilyId: session.familyId,
    // Never older than the account's cut-off, even in the same second.
    issuedAt: tokensValidFromSeconds(user.tokens_valid_from),
  });
  const permissions = await loadPermissions(deps.db, user.id, user.role);
  return {
    user: toAuthenticatedUser(user),
    permissions,
    accessToken: access.token,
    expiresIn: access.expiresIn,
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.expiresAt,
    surface: surfaceOf(user.role),
  };
}

export async function signIn(
  deps: AuthDeps,
  input: { identifier: string; password: string; surface: Surface },
  meta: RequestMeta,
): Promise<SessionBundle> {
  const { db, config } = deps;
  const email = normalizeEmail(input.identifier);
  const user = await findUserByEmail(db, email);

  if (!user) {
    // Same cost as a real verification, so timing cannot enumerate accounts.
    await verifyDummyPassword(input.password);
    await recordLoginAttempt(db, { email, userId: null, ipHash: meta.ipHash, successful: false, failureKind: 'unknown_account' });
    await recordSecurityEvent(db, {
      event: SecurityEvent.LOGIN_FAILED,
      severity: 'notice',
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      metadata: { reason: 'unknown_account' },
    });
    throw invalidCredentials();
  }

  if (isLocked(user)) {
    await recordLoginAttempt(db, { email, userId: user.id, ipHash: meta.ipHash, successful: false, failureKind: 'locked' });
    await recordSecurityEvent(db, {
      event: SecurityEvent.LOGIN_BLOCKED_LOCKED,
      severity: 'warning',
      actorId: user.id,
      actorRole: user.role,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
    });
    throw new AppError('account_locked', 'Too many failed attempts. Please try again later.');
  }

  const passwordOk = await verifyPassword(user.password_hash, input.password);
  if (!passwordOk) {
    const { locked } = await recordFailedLogin(
      db,
      user.id,
      config.LOGIN_MAX_FAILED_ATTEMPTS,
      config.LOGIN_LOCKOUT_SECONDS,
    );
    await recordLoginAttempt(db, { email, userId: user.id, ipHash: meta.ipHash, successful: false, failureKind: 'wrong_password' });
    await recordSecurityEvent(db, {
      event: SecurityEvent.LOGIN_FAILED,
      severity: 'notice',
      actorId: user.id,
      actorRole: user.role,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      metadata: { reason: 'wrong_password' },
    });
    if (locked) {
      await recordSecurityEvent(db, {
        event: SecurityEvent.ACCOUNT_LOCKED,
        severity: 'warning',
        actorId: user.id,
        actorRole: user.role,
        ipHash: meta.ipHash,
        requestId: meta.requestId,
      });
    }
    throw invalidCredentials();
  }

  if (user.status !== 'active') {
    await recordLoginAttempt(db, { email, userId: user.id, ipHash: meta.ipHash, successful: false, failureKind: 'inactive' });
    throw new AppError('account_inactive', 'This account is not active.');
  }

  if (surfaceOf(user.role) !== input.surface) {
    await recordLoginAttempt(db, { email, userId: user.id, ipHash: meta.ipHash, successful: false, failureKind: 'wrong_surface' });
    await recordSecurityEvent(db, {
      event: SecurityEvent.LOGIN_WRONG_SURFACE,
      severity: 'notice',
      actorId: user.id,
      actorRole: user.role,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      metadata: { requestedSurface: input.surface },
    });
    throw new AppError(
      'wrong_surface',
      input.surface === 'mobile'
        ? 'Admin and moderator accounts sign in on the console website.'
        : 'Client and mechanic accounts sign in on the mobile app.',
    );
  }

  // Cost parameters were raised since this hash was made: upgrade it now,
  // while we hold the plaintext.
  if (needsRehash(user.password_hash)) {
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      user.id,
      await hashPassword(input.password),
    ]);
  }

  await recordSuccessfulLogin(db, user.id);
  const bundle = await openSession(deps, user, meta);
  await recordLoginAttempt(db, { email, userId: user.id, ipHash: meta.ipHash, successful: true });
  await recordSecurityEvent(db, {
    event: SecurityEvent.LOGIN_SUCCEEDED,
    actorId: user.id,
    actorRole: user.role,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
    metadata: { surface: input.surface },
  });
  return bundle;
}

export async function register(
  deps: AuthDeps,
  input: {
    email: string;
    password: string;
    firstName: string;
    lastName?: string;
    phone?: string;
    role: 'client' | 'mechanic';
  },
  meta: RequestMeta,
): Promise<SessionBundle> {
  const { db } = deps;
  const email = normalizeEmail(input.email);

  const localPart = email.split('@')[0] ?? '';
  if (localPart.length >= 4 && input.password.toLowerCase().includes(localPart)) {
    throw new AppError('validation_failed', 'Password must not contain your email address.');
  }

  if (await findUserByEmail(db, email)) {
    throw conflict('An account with that email already exists.');
  }

  const passwordHash = await hashPassword(input.password);
  let user: UserRow;
  try {
    user = await insertUser(db, {
      email,
      passwordHash,
      role: input.role,
      firstName: input.firstName,
      lastName: input.lastName ?? '',
      phone: input.phone,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('An account with that email already exists.');
    throw err;
  }

  await recordSecurityEvent(db, {
    event: SecurityEvent.ACCOUNT_REGISTERED,
    actorId: user.id,
    actorRole: user.role,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
  });

  return openSession(deps, user, meta);
}

export async function refresh(
  deps: AuthDeps,
  input: { refreshToken: string },
  meta: RequestMeta,
): Promise<SessionBundle> {
  const { db } = deps;
  const rotated = await rotateSession(db, {
    refreshToken: input.refreshToken,
    ipHash: meta.ipHash,
    userAgentHash: meta.userAgentHash,
    requestId: meta.requestId,
  });

  const user = await findUserById(db, rotated.userId);
  if (!user || user.status !== 'active') {
    await revokeFamily(db, rotated.familyId, 'revoked_by_admin');
    throw new AppError('account_inactive', 'This account is not active.');
  }

  const access = await issueAccessToken({
    userId: user.id,
    role: user.role,
    sessionFamilyId: rotated.familyId,
    issuedAt: tokensValidFromSeconds(user.tokens_valid_from),
  });
  await recordSecurityEvent(db, {
    event: SecurityEvent.TOKEN_REFRESHED,
    actorId: user.id,
    actorRole: user.role,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
  });

  return {
    user: toAuthenticatedUser(user),
    permissions: await loadPermissions(db, user.id, user.role),
    accessToken: access.token,
    expiresIn: access.expiresIn,
    refreshToken: rotated.refreshToken,
    refreshExpiresAt: rotated.expiresAt,
    surface: surfaceOf(user.role),
  };
}

/**
 * Revokes the caller's session family. Accepts either credential, because a
 * client whose access token already expired must still be able to sign out.
 * Idempotent: signing out twice is not an error.
 */
export async function signOut(
  deps: AuthDeps,
  input: { accessToken: string | null; refreshToken: string | null },
  meta: RequestMeta,
): Promise<void> {
  const { db } = deps;
  let familyId: string | null = null;
  let userId: string | null = null;

  if (input.accessToken) {
    try {
      const claims = await verifyAccessToken(input.accessToken);
      familyId = claims.sid;
      userId = claims.sub;
    } catch {
      // Expired or invalid — fall through to the refresh token.
    }
  }
  if (!familyId && input.refreshToken) {
    const found = await findFamilyByRefreshToken(db, input.refreshToken);
    if (found) {
      familyId = found.familyId;
      userId = found.userId;
    }
  }
  if (!familyId) return;

  await revokeFamily(db, familyId, 'logout');
  await recordSecurityEvent(db, {
    event: SecurityEvent.LOGOUT,
    actorId: userId,
    targetType: 'session_family',
    targetId: familyId,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
  });
}

/**
 * Changes the password and signs every OTHER device out. The caller keeps
 * their session but needs the new access token this returns, because the
 * change retires every access token issued before it.
 */
export async function changePassword(
  deps: AuthDeps,
  auth: AuthContext,
  input: { currentPassword: string; newPassword: string },
  meta: RequestMeta,
): Promise<{ accessToken: string; expiresIn: number }> {
  const { db } = deps;
  const user = await findUserById(db, auth.userId);
  if (!user) throw unauthorized();

  if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
    await recordSecurityEvent(db, {
      event: SecurityEvent.LOGIN_FAILED,
      severity: 'notice',
      actorId: user.id,
      actorRole: user.role,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      metadata: { reason: 'password_change_wrong_current' },
    });
    throw new AppError('invalid_credentials', 'The current password is incorrect.');
  }
  if (input.currentPassword === input.newPassword) {
    throw new AppError('validation_failed', 'The new password must be different from the current one.');
  }

  const passwordHash = await hashPassword(input.newPassword);
  const { tokensValidFrom } = await db.withTransaction(async (tx) => {
    const updated = await updatePassword(tx, user.id, passwordHash);
    await revokeUserSessions(tx, user.id, 'password_changed', auth.sessionFamilyId);
    return updated;
  });
  await recordSecurityEvent(db, {
    event: SecurityEvent.PASSWORD_CHANGED,
    severity: 'notice',
    actorId: user.id,
    actorRole: user.role,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
  });

  // Minted with the database's clock so it is never older than the cut-off
  // it just moved — see tokensValidFromSeconds in auth/guard.ts.
  const access = await issueAccessToken({
    userId: user.id,
    role: user.role,
    sessionFamilyId: auth.sessionFamilyId,
    issuedAt: tokensValidFromSeconds(tokensValidFrom),
  });
  return { accessToken: access.token, expiresIn: access.expiresIn };
}

function resetCodeHash(userId: string, code: string): Buffer {
  return hmacSha256(`password-reset:${userId}:${code}`);
}

/**
 * Issues a one-time code. Answers the same way whether or not the account
 * exists; the difference is only visible in the security log.
 */
export async function requestPasswordReset(
  deps: AuthDeps,
  input: { email: string },
  meta: RequestMeta,
): Promise<void> {
  const { db, config } = deps;
  const email = normalizeEmail(input.email);
  const user = await findUserByEmail(db, email);

  if (!user || user.status !== 'active') {
    await recordSecurityEvent(db, {
      event: SecurityEvent.PASSWORD_RESET_REQUESTED,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      metadata: { outcome: user ? 'inactive_account' : 'unknown_account' },
    });
    return;
  }

  // Per-email ceiling: the IP rate limit stops one client spamming; this stops
  // many clients flooding one inbox. Over the limit, answer as normal (202) but
  // issue nothing.
  const recent = await db.queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM password_reset_codes
       WHERE user_id = $1 AND created_at > now() - ($2::int * interval '1 second')`,
    [user.id, config.PASSWORD_RESET_EMAIL_WINDOW_SECONDS],
  );
  if ((recent?.n ?? 0) >= config.PASSWORD_RESET_EMAIL_MAX) {
    await recordSecurityEvent(db, {
      event: SecurityEvent.PASSWORD_RESET_REQUESTED,
      severity: 'warning',
      actorId: user.id,
      actorRole: user.role,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      metadata: { outcome: 'rate_limited_email' },
    });
    return;
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expiresAt = new Date(Date.now() + config.PASSWORD_RESET_CODE_TTL_SECONDS * 1000);

  await db.withTransaction(async (tx) => {
    // One live code per account: a new request retires the previous one.
    await tx.query(
      'UPDATE password_reset_codes SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL',
      [user.id],
    );
    await tx.query(
      `INSERT INTO password_reset_codes (user_id, code_hash, expires_at)
       VALUES ($1, $2, $3::timestamptz)`,
      [user.id, resetCodeHash(user.id, code), expiresAt],
    );
  });

  await deps.codeDelivery.deliverPasswordResetCode({
    email,
    code,
    expiresInSeconds: config.PASSWORD_RESET_CODE_TTL_SECONDS,
  });
  await recordSecurityEvent(db, {
    event: SecurityEvent.PASSWORD_RESET_REQUESTED,
    actorId: user.id,
    actorRole: user.role,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
    metadata: { outcome: 'code_issued' },
  });
}

export async function confirmPasswordReset(
  deps: AuthDeps,
  input: { email: string; code: string; newPassword: string },
  meta: RequestMeta,
): Promise<void> {
  const { db, config } = deps;
  const rejected = () => new AppError('invalid_reset_code', 'That code is invalid or has expired.');
  const reject = async (userId: string | null, reason: string) => {
    await recordSecurityEvent(db, {
      event: SecurityEvent.PASSWORD_RESET_REJECTED,
      severity: 'notice',
      actorId: userId,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      metadata: { reason },
    });
    return rejected();
  };

  const user = await findUserByEmail(db, normalizeEmail(input.email));
  if (!user || user.status !== 'active') throw await reject(null, 'unknown_account');

  const row = await db.queryOne<{
    id: string;
    code_hash: Buffer | Uint8Array;
    expires_at: Date;
    attempts: number;
  }>(
    `SELECT id, code_hash, expires_at, attempts
       FROM password_reset_codes
      WHERE user_id = $1 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [user.id],
  );
  if (!row) throw await reject(user.id, 'no_code');
  if (row.expires_at.getTime() <= Date.now()) throw await reject(user.id, 'expired');
  if (row.attempts >= config.PASSWORD_RESET_MAX_ATTEMPTS) throw await reject(user.id, 'too_many_attempts');

  if (!safeEqual(Buffer.from(row.code_hash), resetCodeHash(user.id, input.code))) {
    await db.query('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw await reject(user.id, 'wrong_code');
  }

  const passwordHash = await hashPassword(input.newPassword);
  await db.withTransaction(async (tx) => {
    await tx.query('UPDATE password_reset_codes SET consumed_at = now() WHERE id = $1', [row.id]);
    await updatePassword(tx, user.id, passwordHash);
    await revokeUserSessions(tx, user.id, 'password_changed');
  });
  await recordSecurityEvent(db, {
    event: SecurityEvent.PASSWORD_RESET_COMPLETED,
    severity: 'notice',
    actorId: user.id,
    actorRole: user.role,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
  });
}
