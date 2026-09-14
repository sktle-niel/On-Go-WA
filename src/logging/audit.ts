import type { Queryable } from '../db/database.js';
import { logger } from './logger.js';

/**
 * The security event trail.
 *
 * Every entry goes to two places: the `security_events` table (queryable,
 * append-only — the application role has no UPDATE or DELETE on it) and the
 * structured log stream (shippable to CloudWatch, where a metric filter can
 * alarm on it).
 *
 * The rule this module enforces mechanically: an event records WHAT happened,
 * WHO did it and FROM WHERE, and never the secret involved. There is no code
 * path that writes a password, an access token, a refresh token or a session
 * hash into either sink — `scrubMetadata` drops those keys outright rather
 * than trusting each call site to remember.
 */

export type SecuritySeverity = 'info' | 'notice' | 'warning' | 'critical';

export const SecurityEvent = {
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  LOGIN_BLOCKED_LOCKED: 'auth.login.blocked_locked',
  LOGIN_WRONG_SURFACE: 'auth.login.wrong_surface',
  ACCOUNT_LOCKED: 'auth.account.locked',
  ACCOUNT_REGISTERED: 'auth.account.registered',
  PASSWORD_CHANGED: 'auth.password.changed',
  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  PASSWORD_RESET_REJECTED: 'auth.password.reset_rejected',
  TOKEN_REFRESHED: 'auth.token.refreshed',
  TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',
  LOGOUT: 'auth.logout',
  LOGOUT_ALL: 'auth.logout_all',
  SESSION_REVOKED: 'auth.session.revoked',
  AUTHZ_DENIED: 'authz.denied',
  AUTHZ_OWNERSHIP_DENIED: 'authz.ownership_denied',
  PRIVILEGE_CHANGED: 'authz.privilege_changed',
  RATE_LIMITED: 'api.rate_limited',
  VALIDATION_REJECTED: 'api.validation_rejected',
  MODERATION_DECISION: 'moderation.decision',
  ADMIN_ACTION: 'admin.action',
} as const;

export type SecurityEventName = (typeof SecurityEvent)[keyof typeof SecurityEvent];

/** Keys that must never reach a log line or a database row. */
const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'confirmpassword',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'refreshtokenhash',
  'code',
  'secret',
  'pepper',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
]);

const MAX_METADATA_STRING = 500;

function scrubMetadata(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) continue;
    if (value === null || value === undefined) continue;

    if (typeof value === 'string') {
      out[key] =
        value.length > MAX_METADATA_STRING ? `${value.slice(0, MAX_METADATA_STRING)}...` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else {
      // Anything structured is summarised, not embedded — nested objects are
      // where secrets sneak in.
      out[key] = `[${Array.isArray(value) ? 'array' : typeof value}]`;
    }
  }
  return out;
}

export interface SecurityEventInput {
  event: SecurityEventName;
  severity?: SecuritySeverity;
  actorId?: string | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ipHash?: Buffer | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Records an event. Never throws: a failure to write the audit trail must not
 * take down the request that triggered it, but it IS logged at error level so
 * the gap is visible and alarmable.
 */
export async function recordSecurityEvent(db: Queryable, input: SecurityEventInput): Promise<void> {
  const severity = input.severity ?? 'info';
  const metadata = scrubMetadata(input.metadata);

  const logPayload = {
    securityEvent: input.event,
    severity,
    actorId: input.actorId ?? undefined,
    actorRole: input.actorRole ?? undefined,
    targetType: input.targetType ?? undefined,
    targetId: input.targetId ?? undefined,
    requestId: input.requestId ?? undefined,
    ...metadata,
  };

  if (severity === 'critical') logger.error(logPayload, input.event);
  else if (severity === 'warning') logger.warn(logPayload, input.event);
  else logger.info(logPayload, input.event);

  try {
    await db.query(
      `INSERT INTO security_events
         (event, severity, actor_id, actor_role, target_type, target_id,
          ip_hash, request_id, metadata)
       VALUES ($1, $2, $3, $4::user_role, $5, $6, $7, $8, $9::jsonb)`,
      [
        input.event,
        severity,
        input.actorId ?? null,
        input.actorRole ?? null,
        input.targetType ?? null,
        input.targetId ?? null,
        input.ipHash ?? null,
        input.requestId ?? null,
        JSON.stringify(metadata),
      ],
    );
  } catch (err) {
    logger.error(
      { err: { message: (err as Error).message }, securityEvent: input.event },
      'failed to persist security event',
    );
  }
}

/**
 * Login attempts get their own narrow table: it is written on every attempt
 * including failures, and is what the lockout logic and spray detection read.
 */
export async function recordLoginAttempt(
  db: Queryable,
  input: {
    email: string | null;
    userId: string | null;
    ipHash: Buffer | null;
    successful: boolean;
    failureKind?: string | null;
  },
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO login_attempts (email, user_id, ip_hash, successful, failure_kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.email, input.userId, input.ipHash, input.successful, input.failureKind ?? null],
    );
  } catch (err) {
    logger.error({ err: { message: (err as Error).message } }, 'failed to persist login attempt');
  }
}
