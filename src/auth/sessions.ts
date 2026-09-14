import { loadConfig } from '../config/env.js';
import type { Database, Queryable } from '../db/database.js';
import { recordSecurityEvent, SecurityEvent } from '../logging/audit.js';
import { generateOpaqueToken, newUuid, sha256 } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';

/**
 * Refresh tokens and session families.
 *
 * A refresh token is 256 bits of randomness the server hands out once and
 * stores only as a SHA-256 digest. Every use ROTATES it: the presented token is
 * retired and a new one issued, both rows sharing a `family_id`.
 *
 * That rotation is what makes theft detectable. If a token is presented after
 * it was already rotated, two parties hold the same secret — the legitimate
 * client and whoever copied it — and there is no way to tell which one is
 * calling. The only safe answer is to revoke the entire family, so both are
 * signed out and the real user notices. That is `reuse_detected`.
 *
 * Two clocks bound a session: an idle timeout renewed on each refresh, and an
 * absolute ceiling set at sign-in that no amount of activity extends.
 */

export type SessionEndReason =
  | 'logout'
  | 'logout_all'
  | 'rotated'
  | 'expired'
  | 'reuse_detected'
  | 'password_changed'
  | 'revoked_by_admin';

export interface IssuedRefresh {
  refreshToken: string;
  familyId: string;
  expiresAt: Date;
}

export interface RotatedSession extends IssuedRefresh {
  userId: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  revoked_at: Date | null;
  end_reason: SessionEndReason | null;
  expires_at: Date;
  absolute_expires_at: Date;
}

function idleExpiry(now: Date, absolute: Date): Date {
  const idle = new Date(now.getTime() + loadConfig().REFRESH_TOKEN_TTL_SECONDS * 1000);
  return idle.getTime() < absolute.getTime() ? idle : absolute;
}

export async function createSession(
  db: Queryable,
  input: { userId: string; ipHash: Buffer | null; userAgentHash: Buffer | null },
): Promise<IssuedRefresh> {
  const now = new Date();
  const absolute = new Date(now.getTime() + loadConfig().SESSION_ABSOLUTE_TTL_SECONDS * 1000);
  const expiresAt = idleExpiry(now, absolute);
  const refreshToken = generateOpaqueToken();
  const familyId = newUuid();

  await db.query(
    `INSERT INTO sessions
       (user_id, family_id, refresh_token_hash, user_agent_hash, ip_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
    [input.userId, familyId, sha256(refreshToken), input.userAgentHash, input.ipHash, expiresAt, absolute],
  );

  return { refreshToken, familyId, expiresAt };
}

export async function rotateSession(
  db: Database,
  input: {
    refreshToken: string;
    ipHash: Buffer | null;
    userAgentHash: Buffer | null;
    requestId: string | null;
  },
): Promise<RotatedSession> {
  const presentedHash = sha256(input.refreshToken);

  // The revocations below must COMMIT even though the request fails, so the
  // transaction returns an outcome and the throw happens outside it.
  type Outcome =
    | { kind: 'rotated'; session: RotatedSession }
    | { kind: 'missing' }
    | { kind: 'reuse'; familyId: string }
    | { kind: 'expired' };

  const outcome = await db.withTransaction<Outcome>(async (tx) => {
    const row = await tx.queryOne<SessionRow>(
      `SELECT id, user_id, family_id, revoked_at, end_reason::text AS end_reason,
              expires_at, absolute_expires_at
         FROM sessions WHERE refresh_token_hash = $1
         FOR UPDATE`,
      [presentedHash],
    );
    if (!row) return { kind: 'missing' };

    const now = new Date();

    // A token retired by sign-out, a password change or an earlier reuse is
    // simply dead. Only a token that was ROTATED and comes back is evidence
    // that two parties hold it.
    if (row.revoked_at !== null && row.end_reason !== 'rotated') return { kind: 'missing' };

    if (row.revoked_at !== null) {
      await revokeFamily(tx, row.family_id, 'reuse_detected');
      await recordSecurityEvent(tx, {
        event: SecurityEvent.TOKEN_REUSE_DETECTED,
        severity: 'critical',
        actorId: row.user_id,
        targetType: 'session_family',
        targetId: row.family_id,
        ipHash: input.ipHash,
        requestId: input.requestId,
      });
      return { kind: 'reuse', familyId: row.family_id };
    }

    if (row.expires_at.getTime() <= now.getTime() || row.absolute_expires_at.getTime() <= now.getTime()) {
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), end_reason = 'expired'::session_end_reason WHERE id = $1`,
        [row.id],
      );
      return { kind: 'expired' };
    }

    const refreshToken = generateOpaqueToken();
    const expiresAt = idleExpiry(now, row.absolute_expires_at);
    const inserted = await tx.queryOne<{ id: string }>(
      `INSERT INTO sessions
         (user_id, family_id, refresh_token_hash, user_agent_hash, ip_hash, expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)
       RETURNING id`,
      [row.user_id, row.family_id, sha256(refreshToken), input.userAgentHash, input.ipHash, expiresAt, row.absolute_expires_at],
    );
    await tx.query(
      `UPDATE sessions
          SET revoked_at = now(), end_reason = 'rotated'::session_end_reason,
              replaced_by = $2, last_used_at = now()
        WHERE id = $1`,
      [row.id, inserted?.id ?? null],
    );

    return {
      kind: 'rotated',
      session: { refreshToken, familyId: row.family_id, expiresAt, userId: row.user_id },
    };
  });

  switch (outcome.kind) {
    case 'rotated':
      return outcome.session;
    case 'reuse':
      throw new AppError('token_invalid', 'Invalid refresh token.', {
        logContext: { reason: 'reuse_detected', familyId: outcome.familyId },
      });
    case 'expired':
      throw new AppError('token_expired', 'Your session has expired. Please sign in again.');
    case 'missing':
    default:
      throw new AppError('token_invalid', 'Invalid refresh token.');
  }
}

/** The family a live refresh token belongs to, or null. Used by sign-out. */
export function findFamilyByRefreshToken(
  db: Queryable,
  refreshToken: string,
): Promise<{ familyId: string; userId: string } | null> {
  return db
    .queryOne<{ family_id: string; user_id: string }>(
      `SELECT family_id, user_id FROM sessions
        WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [sha256(refreshToken)],
    )
    .then((row) => (row ? { familyId: row.family_id, userId: row.user_id } : null));
}

export function revokeFamily(db: Queryable, familyId: string, reason: SessionEndReason): Promise<unknown> {
  return db.query(
    `UPDATE sessions SET revoked_at = now(), end_reason = $2::session_end_reason
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
  );
}

/** Signs a user out everywhere, optionally keeping one family (the caller's). */
export function revokeUserSessions(
  db: Queryable,
  userId: string,
  reason: SessionEndReason,
  exceptFamilyId: string | null = null,
): Promise<unknown> {
  return db.query(
    `UPDATE sessions SET revoked_at = now(), end_reason = $2::session_end_reason
      WHERE user_id = $1 AND revoked_at IS NULL
        AND ($3::uuid IS NULL OR family_id <> $3::uuid)`,
    [userId, reason, exceptFamilyId],
  );
}
