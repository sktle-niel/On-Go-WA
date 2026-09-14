/**
 * Test configuration. Imported FIRST by every test file, before any module
 * that reads config at load time (the logger does), so the values are in the
 * environment when validation runs.
 *
 * Argon2 parameters are the OWASP minimum here so a test run does not spend
 * its time hashing; production defaults are higher (see config/env.ts).
 */
const env: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-0123456789abcdef0123456789abcdef',
  PASSWORD_PEPPER: 'test-pepper-0123456789abcdef',
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
};

for (const [key, value] of Object.entries(env)) {
  process.env[key] = value;
}

export {};
