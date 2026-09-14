import { z } from 'zod';

/**
 * The single source of truth for configuration.
 *
 * Every value is validated at boot; the process refuses to start on a bad or
 * missing setting rather than discovering it at the first request. Production
 * additionally forbids the permissive defaults that are convenient locally
 * (wildcard CORS, unverified database TLS, long-lived access tokens).
 */

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const durationSeconds = (fallback: number) =>
  z.coerce.number().int().positive().max(60 * 60 * 24 * 365).default(fallback);

const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    /** Number of proxy hops in front of the app (ALB = 1). Controls whose
     *  X-Forwarded-For we are willing to believe when rate limiting by IP. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    /** The URL clients reach this API at. Used for the OpenAPI document. */
    PUBLIC_BASE_URL: z.string().regex(/^https?:\/\/\S+$/).optional(),

    /** Swagger UI at /docs. Defaults to on outside production. */
    DOCS_ENABLED: flag.optional(),

    // ── CORS ────────────────────────────────────────────────────────────────
    /** Exact origins allowed to call the API from a browser. Never a wildcard
     *  in production. Native mobile apps send no Origin and are unaffected. */
    CORS_ALLOWED_ORIGINS: z.string().default('').transform(csv),
    /** Also allow http://localhost:* and http://127.0.0.1:* — for a staging
     *  API that a developer's local Flutter web build talks to. Never on the
     *  real production service. */
    CORS_ALLOW_LOCALHOST: flag.optional(),

    // ── Tokens ──────────────────────────────────────────────────────────────
    /** HS256 signing key. Must be >= 32 bytes of real entropy. */
    JWT_SIGNING_KEY: z.string().min(32),
    /** Optional previous key, kept valid for verification during rotation. */
    JWT_PREVIOUS_SIGNING_KEY: z.string().min(32).optional(),
    JWT_ISSUER: z.string().min(1).default('ongo-api'),
    JWT_AUDIENCE: z.string().min(1).default('ongo-app'),

    /** Access tokens are deliberately short-lived — the compromise window,
     *  not convenience, sets this number. Refresh handles continuity. */
    ACCESS_TOKEN_TTL_SECONDS: durationSeconds(600),
    /** Idle timeout: a refresh token unused for this long is dead. */
    REFRESH_TOKEN_TTL_SECONDS: durationSeconds(60 * 60 * 24 * 14),
    /** Hard ceiling on a session regardless of activity — forces re-auth. */
    SESSION_ABSOLUTE_TTL_SECONDS: durationSeconds(60 * 60 * 24 * 60),

    /** The console keeps its refresh token in an httpOnly cookie. */
    REFRESH_COOKIE_NAME: z.string().min(1).default('ongo_refresh'),
    REFRESH_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    REFRESH_COOKIE_DOMAIN: z.string().min(1).optional(),

    // ── Password hashing ────────────────────────────────────────────────────
    /** Server-side secret mixed into every hash. Sits in Secrets Manager, not
     *  the database, so a stolen table dump alone cannot be cracked offline. */
    PASSWORD_PEPPER: z.string().min(16),
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(19456).default(65536),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(3),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

    PASSWORD_RESET_CODE_TTL_SECONDS: durationSeconds(600),
    PASSWORD_RESET_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    /** Cap on reset codes issued to one account in the window, so a single
     *  inbox cannot be flooded even from many IPs. */
    PASSWORD_RESET_EMAIL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    PASSWORD_RESET_EMAIL_WINDOW_SECONDS: durationSeconds(3600),

    // ── Database ────────────────────────────────────────────────────────────
    PGHOST: z.string().min(1),
    PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
    PGDATABASE: z.string().min(1),
    PGUSER: z.string().min(1),
    PGPASSWORD: z.string().min(1),
    /** verify-full is the only mode that actually stops an active MITM. */
    PGSSLMODE: z.enum(['disable', 'require', 'verify-ca', 'verify-full']).default('verify-full'),
    /** PEM bundle of the database's CA — path or inline PEM. Required for
     *  providers with a private CA (RDS, Cloud SQL, Supabase). Leave unset
     *  for providers whose certificate chains to a public root (Neon):
     *  Node's built-in trust store verifies it. Either way an untrusted
     *  certificate fails the connection; it is never silently accepted. */
    PG_CA_CERT: z.string().optional(),
    PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

    // ── Redis (optional) ────────────────────────────────────────────────────
    /** When set, rate limits and live events are shared across instances.
     *  When unset, both are in-process: correct for one instance only. */
    REDIS_URL: z.string().regex(/^rediss?:\/\/\S+$/).optional(),

    // ── Rate limiting / lockout ─────────────────────────────────────────────
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_GLOBAL_WINDOW_SECONDS: durationSeconds(60),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_AUTH_WINDOW_SECONDS: durationSeconds(300),
    /** Failed logins before the account itself is temporarily locked. */
    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).default(8),
    LOGIN_LOCKOUT_SECONDS: durationSeconds(900),

    // ── Limits ──────────────────────────────────────────────────────────────
    MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1024).default(256 * 1024),
    WS_HEARTBEAT_SECONDS: durationSeconds(30),

    // ── Load shedding (@fastify/under-pressure) ───────────────────────────
    /** Answer 503 while the event loop lags more than this (ms). 0 disables.
     *  Tests set 0: PGlite runs Postgres on the main thread and a slow CI
     *  runner would otherwise shed the very requests under test. */
    LOAD_SHED_MAX_EVENT_LOOP_DELAY_MS: z.coerce.number().int().min(0).default(1000),
    /** Answer 503 above this event loop utilization (0–1). 0 disables. */
    LOAD_SHED_MAX_EVENT_LOOP_UTILIZATION: z.coerce.number().min(0).max(1).default(0.98),

    // ── Object storage ───────────────────────────────────────────────────────
    /** Where uploaded files live. `disk` is for dev/tests and a single-instance
     *  demo; a cloud driver (GCS/S3) is swapped in for real deployments. */
    STORAGE_DRIVER: z.enum(['disk']).default('disk'),
    /** Directory the disk driver writes to (relative to the working dir). */
    UPLOAD_DIR: z.string().min(1).default('uploads'),
    /** How long a signed link to a private document stays valid. */
    FILE_URL_TTL_SECONDS: durationSeconds(600),
    /** Most documents one verification request may hold, so a single account
     *  cannot fill storage by uploading without bound. */
    MAX_DOCUMENTS_PER_REQUEST: z.coerce.number().int().min(1).max(100).default(20),
    /** Upload ceilings, enforced on the bytes actually received. Documents
     *  accept images and PDF; the background accepts images only. */
    MAX_DOCUMENT_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
    MAX_BACKGROUND_BYTES: z.coerce.number().int().min(1024).default(5 * 1024 * 1024),

    // ── Code delivery (password reset) ────────────────────────────────────────
    /** `log` prints the code (dev only); `smtp` sends real email through any
     *  SMTP provider. Selecting `smtp` requires the SMTP_* settings below. */
    DELIVERY_DRIVER: z.enum(['log', 'smtp']).default('log'),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    /** True for implicit TLS (port 465); false for STARTTLS (587). */
    SMTP_SECURE: flag.optional(),
    SMTP_USER: z.string().min(1).optional(),
    /** From Secret Manager in a deployed environment, never committed. */
    SMTP_PASSWORD: z.string().min(1).optional(),
    /** The From address, e.g. no-reply@ongo.example. */
    SMTP_FROM: z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/).optional(),
    SMTP_FROM_NAME: z.string().min(1).default('On Go'),

    // ── Reporting ───────────────────────────────────────────────────────────
    /** The calendar the revenue ledger is bucketed by month in. */
    REVENUE_TIMEZONE: z.string().min(1).default('Asia/Manila'),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    // Choosing the SMTP driver means its connection settings are mandatory,
    // in every environment — a half-configured sender fails silently at send.
    if (env.DELIVERY_DRIVER === 'smtp') {
      if (!env.SMTP_HOST) fail('SMTP_HOST', 'required when DELIVERY_DRIVER=smtp');
      if (!env.SMTP_USER) fail('SMTP_USER', 'required when DELIVERY_DRIVER=smtp');
      if (!env.SMTP_PASSWORD) fail('SMTP_PASSWORD', 'required when DELIVERY_DRIVER=smtp');
      if (!env.SMTP_FROM) fail('SMTP_FROM', 'required when DELIVERY_DRIVER=smtp');
    }

    if (env.NODE_ENV !== 'production') return;

    if (env.CORS_ALLOWED_ORIGINS.length === 0 && !env.CORS_ALLOW_LOCALHOST) {
      fail('CORS_ALLOWED_ORIGINS', 'must list explicit origins in production');
    }
    if (env.CORS_ALLOWED_ORIGINS.includes('*')) {
      fail('CORS_ALLOWED_ORIGINS', 'wildcard origin is not allowed in production');
    }
    if (env.CORS_ALLOWED_ORIGINS.some((origin) => origin.startsWith('http://'))) {
      fail('CORS_ALLOWED_ORIGINS', 'plaintext http origins are not allowed in production');
    }
    if (env.PGSSLMODE !== 'verify-full') {
      fail('PGSSLMODE', 'database connections must use verify-full in production');
    }
    if (env.ACCESS_TOKEN_TTL_SECONDS > 900) {
      fail('ACCESS_TOKEN_TTL_SECONDS', 'access tokens must live at most 15 minutes in production');
    }
    if (env.REFRESH_COOKIE_SAMESITE === 'none' && !env.REFRESH_COOKIE_DOMAIN) {
      fail('REFRESH_COOKIE_DOMAIN', 'required when the refresh cookie is SameSite=None');
    }
  });

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

/**
 * Validates and returns configuration. On failure the reported message names
 * only the offending KEYS — never the values, which are secrets.
 */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration — ${detail}`);
  }

  cached = parsed.data;
  return cached;
}

/** Tests change the environment between cases; nothing else should call this. */
export function resetConfigCache(): void {
  cached = null;
}

export function isProduction(): boolean {
  return loadConfig().NODE_ENV === 'production';
}

export function docsEnabled(config: AppConfig): boolean {
  return config.DOCS_ENABLED ?? config.NODE_ENV !== 'production';
}
