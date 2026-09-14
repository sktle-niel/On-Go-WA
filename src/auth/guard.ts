import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Queryable } from '../db/database.js';
import { recordSecurityEvent, SecurityEvent } from '../logging/audit.js';
import { AppError, forbidden, unauthorized } from '../utils/errors.js';
import { clientIpHash } from '../utils/ip.js';
import { extractBearerToken, verifyAccessToken, type TokenRole } from './tokens.js';
import {
  ALL_PERMISSIONS,
  NO_PERMISSIONS,
  displayNameOf,
  permissionsFromRow,
  type Permissions,
} from './users.js';

/**
 * Who is calling.
 *
 * Built on every authenticated request from the token AND the database, never
 * from the token alone: the row is what says whether the account is still
 * active, whether the session family was signed out, and what a moderator may
 * currently do. A revoked permission or a removed account takes effect on the
 * very next request, not when the token happens to expire.
 */
export interface AuthContext {
  userId: string;
  email: string;
  displayName: string;
  role: TokenRole;
  sessionFamilyId: string;
  permissions: Permissions;
}

interface PrincipalRow {
  id: string;
  email: string;
  role: TokenRole;
  status: string;
  first_name: string;
  last_name: string;
  tokens_valid_from: Date;
  can_approve: boolean | null;
  can_reject: boolean | null;
  can_escalate: boolean | null;
  can_change_background: boolean | null;
  session_active: boolean;
}

/**
 * JWT `iat` has one-second resolution, so a token minted in the same second as
 * a password change would look valid. Rounding the cut-off UP to the next
 * whole second retires it too; the fresh token issued by the change carries
 * that same rounded-up `iat` (see tokensValidFromSeconds) and stays valid.
 */
export function tokensValidFromSeconds(validFrom: Date): number {
  return Math.ceil(validFrom.getTime() / 1000);
}

export async function authenticateAccessToken(db: Queryable, token: string): Promise<AuthContext> {
  const claims = await verifyAccessToken(token);

  const row = await db.queryOne<PrincipalRow>(
    `SELECT u.id, u.email, u.role::text AS role, u.status::text AS status,
            u.first_name, u.last_name, u.tokens_valid_from,
            mp.can_approve, mp.can_reject, mp.can_escalate, mp.can_change_background,
            EXISTS (
              SELECT 1 FROM sessions s
               WHERE s.family_id = $2 AND s.user_id = u.id
                 AND s.revoked_at IS NULL AND s.expires_at > now()
            ) AS session_active
       FROM users u
       LEFT JOIN moderator_permissions mp ON mp.user_id = u.id
      WHERE u.id = $1`,
    [claims.sub, claims.sid],
  );

  if (!row || row.role !== claims.role) {
    throw new AppError('token_invalid', 'Invalid authentication token.', {
      logContext: { reason: row ? 'role_mismatch' : 'unknown_user' },
    });
  }
  if (row.status !== 'active') {
    throw new AppError('account_inactive', 'This account is not active.');
  }
  if (!row.session_active) {
    throw new AppError('token_invalid', 'This session has been signed out.', {
      logContext: { reason: 'session_revoked' },
    });
  }
  if (tokensValidFromSeconds(row.tokens_valid_from) > claims.iat) {
    throw new AppError('token_expired', 'Your session has expired. Please sign in again.', {
      logContext: { reason: 'tokens_valid_from' },
    });
  }

  const permissions =
    row.role === 'admin'
      ? ALL_PERMISSIONS
      : row.role === 'moderator'
        ? permissionsFromRow(row)
        : NO_PERMISSIONS;

  return {
    userId: row.id,
    email: row.email,
    displayName: displayNameOf(row),
    role: row.role,
    sessionFamilyId: claims.sid,
    permissions,
  };
}

/**
 * Route guard. Rejects anonymous callers with 401 and, when `roles` is given,
 * callers of any other role with 403 (and a security event, because a client
 * probing admin routes is worth knowing about).
 */
export function requireAuth(options: { roles?: readonly TokenRole[] } = {}): preHandlerAsyncHookHandler {
  return async function requireAuthHook(request) {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) throw unauthorized();

    const auth = await authenticateAccessToken(request.server.db, token);

    if (options.roles && !options.roles.includes(auth.role)) {
      await recordSecurityEvent(request.server.db, {
        event: SecurityEvent.AUTHZ_DENIED,
        severity: 'warning',
        actorId: auth.userId,
        actorRole: auth.role,
        ipHash: clientIpHash(request),
        requestId: request.id,
        metadata: { method: request.method, route: request.routeOptions.url ?? request.url },
      });
      throw forbidden();
    }

    request.auth = auth;
  };
}

/**
 * Permission guard for console operations. Admins pass unconditionally;
 * moderators need the flag their admin granted. Register AFTER requireAuth.
 */
export function requirePermission(flag: keyof Permissions): preHandlerAsyncHookHandler {
  return async function requirePermissionHook(request) {
    const auth = request.auth;
    if (!auth) throw unauthorized();
    if (auth.role === 'admin') return;
    if (auth.permissions[flag]) return;

    await recordSecurityEvent(request.server.db, {
      event: SecurityEvent.AUTHZ_DENIED,
      severity: 'warning',
      actorId: auth.userId,
      actorRole: auth.role,
      ipHash: clientIpHash(request),
      requestId: request.id,
      metadata: { permission: flag, route: request.routeOptions.url ?? request.url },
    });
    throw forbidden('You do not have that permission.');
  };
}

/** The verified caller, for handlers behind requireAuth. */
export function currentAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export const CONSOLE_ROLES: readonly TokenRole[] = ['admin', 'moderator'];
export const MOBILE_ROLES: readonly TokenRole[] = ['client', 'mechanic'];
