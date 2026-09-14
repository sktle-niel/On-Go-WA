/**
 * Error taxonomy.
 *
 * The split that matters: `publicMessage` is what the caller is allowed to
 * read, `cause`/`logContext` is what only the logs get. Anything thrown that
 * is NOT an AppError is treated as an internal fault and reported to the
 * caller as a bare 500 — no message, no stack, no database text. That default
 * is what keeps driver errors ("duplicate key value violates unique constraint
 * users_email_key"), file paths, and query fragments out of responses.
 *
 * Every error response has one shape:
 *
 *   { "error": { "code": "...", "message": "...", "details"?: ..., "requestId": "..." } }
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'invalid_credentials'
  | 'account_locked'
  | 'account_inactive'
  | 'wrong_surface'
  | 'token_expired'
  | 'token_invalid'
  | 'invalid_reset_code'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'not_implemented'
  | 'service_unavailable'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  invalid_reset_code: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  token_expired: 401,
  token_invalid: 401,
  forbidden: 403,
  account_inactive: 403,
  wrong_surface: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  account_locked: 423,
  rate_limited: 429,
  internal_error: 500,
  not_implemented: 501,
  service_unavailable: 503,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  /** Safe to return to the caller. */
  readonly publicMessage: string;
  /** Structured, non-sensitive extra returned to the caller (field errors). */
  readonly details?: unknown;
  /** Log-only context. Never serialized into a response. */
  readonly logContext?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    publicMessage: string,
    options: { details?: unknown; logContext?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(publicMessage, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.publicMessage = publicMessage;
    this.details = options.details;
    this.logContext = options.logContext;
  }
}

export function isAppError(value: unknown): value is AppError {
  return (
    value instanceof AppError ||
    (typeof value === 'object' && value !== null && (value as { name?: string }).name === 'AppError')
  );
}

/* Constructors for the cases used often enough to be worth naming. */

export const badRequest = (message = 'Malformed request.', details?: unknown) =>
  new AppError('bad_request', message, { details });

export const unauthorized = (message = 'Authentication required.') =>
  new AppError('unauthorized', message);

/**
 * Deliberately identical for "no such user" and "wrong password" — a caller
 * must not be able to enumerate which accounts exist by reading the error.
 */
export const invalidCredentials = (logContext?: Record<string, unknown>) =>
  new AppError('invalid_credentials', 'Incorrect email or password.', { logContext });

export const forbidden = (message = 'You do not have access to this resource.') =>
  new AppError('forbidden', message);

/**
 * Used for both "does not exist" and "exists but is not yours". Returning 404
 * rather than 403 on the second case stops an attacker from confirming that an
 * id is real — the core defence against IDOR probing.
 */
export const notFound = (message = 'Resource not found.') =>
  new AppError('not_found', message);

export const conflict = (message = 'That change conflicts with the current state.') =>
  new AppError('conflict', message);

export const notImplemented = (message = 'This operation is not available yet.') =>
  new AppError('not_implemented', message);

export const internalError = (cause?: unknown, logContext?: Record<string, unknown>) =>
  new AppError('internal_error', 'Something went wrong. Please try again.', {
    cause,
    logContext,
  });

/** PostgreSQL unique_violation, whether raised directly or wrapped by the db layer. */
export function isUniqueViolation(err: unknown): boolean {
  const candidate = isAppError(err) ? err.cause : err;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    (candidate as { code?: string }).code === '23505'
  );
}
