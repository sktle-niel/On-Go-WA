import { randomBytes } from 'node:crypto';

/**
 * Test configuration. Imported FIRST by every test file, before any module
 * that reads config at load time (the logger does), so the values are in the
 * environment when validation runs.
 *
 * Argon2 parameters are the OWASP minimum here so a test run does not spend
 * its time hashing; production defaults are higher (see config/env.ts).
 *
 * The signing key and pepper are generated fresh each run rather than written
 * as literals, so no secret-shaped string ever sits in the source for a
 * scanner to flag. Tokens are minted and verified within the same run, so a
 * per-run value is all the tests need.
 */
const env: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: randomBytes(48).toString('base64url'),
  PASSWORD_PEPPER: randomBytes(24).toString('base64url'),
  PGHOST: 'localhost',
  PGDATABASE: 'ongo_test',
  PGUSER: 'test',
  PGPASSWORD: 'test',
  PGSSLMODE: 'disable',
  ARGON2_MEMORY_KIB: '19456',
  ARGON2_TIME_COST: '2',
  ACCESS_TOKEN_TTL_SECONDS: '600',
  RATE_LIMIT_GLOBAL_MAX: '100000',
  RATE_LIMIT_AUTH_MAX: '100000',
  LOGIN_MAX_FAILED_ATTEMPTS: '3',
  LOGIN_LOCKOUT_SECONDS: '60',
  WS_HEARTBEAT_SECONDS: '1',
  // PGlite runs Postgres on the main thread; on a slow CI runner the event loop
  // lag after migrations would make under-pressure answer 503 to the tests.
  LOAD_SHED_MAX_EVENT_LOOP_DELAY_MS: '0',
  LOAD_SHED_MAX_EVENT_LOOP_UTILIZATION: '0',
};

for (const [key, value] of Object.entries(env)) {
  process.env[key] = value;
}

export {};
