import '../helpers/env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docsEnabled, legacyPaymentReportsEnabled, loadConfig, resetConfigCache } from '../../src/config/env.js';

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  }
}

test('loads the test configuration with defaults applied', () => {
  const config = loadConfig();
  assert.equal(config.NODE_ENV, 'test');
  assert.equal(config.PORT, 8080);
  assert.equal(config.JWT_ISSUER, 'ongo-api');
  assert.deepEqual(config.CORS_ALLOWED_ORIGINS, []);
  assert.equal(docsEnabled(config), true);
});

test('production refuses permissive settings and names only the keys', () => {
  assert.throws(
    () => withEnv({ NODE_ENV: 'production' }, loadConfig),
    (err: Error) =>
      err.message.includes('CORS_ALLOWED_ORIGINS') &&
      err.message.includes('PGSSLMODE') &&
      // The message names offending keys, never their values.
      !err.message.includes(process.env.JWT_SIGNING_KEY ?? 'JWT_SIGNING_KEY_VALUE'),
  );
});

test('production accepts an empty origin list when localhost is explicitly allowed (staging)', () => {
  const config = withEnv(
    { NODE_ENV: 'production', CORS_ALLOW_LOCALHOST: 'true', PGSSLMODE: 'verify-full' },
    loadConfig,
  );
  assert.equal(config.CORS_ALLOW_LOCALHOST, true);
  assert.deepEqual(config.CORS_ALLOWED_ORIGINS, []);
});

test('production with explicit https origins, verify-full and a CA passes', () => {
  const config = withEnv(
    {
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://console.example.com, https://ops.example.com',
      PGSSLMODE: 'verify-full',
      PG_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    },
    loadConfig,
  );
  assert.deepEqual(config.CORS_ALLOWED_ORIGINS, ['https://console.example.com', 'https://ops.example.com']);
  assert.equal(docsEnabled(config), false);
});

test('a short signing key is rejected', () => {
  assert.throws(() => withEnv({ JWT_SIGNING_KEY: 'short' }, loadConfig), /JWT_SIGNING_KEY/);
});

test('legacy payment reports are on outside production, and off in production unless set', () => {
  assert.equal(legacyPaymentReportsEnabled(loadConfig()), true);
  const staging = { NODE_ENV: 'production', CORS_ALLOW_LOCALHOST: 'true', PGSSLMODE: 'verify-full' };
  assert.equal(legacyPaymentReportsEnabled(withEnv(staging, loadConfig)), false);
  assert.equal(legacyPaymentReportsEnabled(withEnv({ ...staging, LEGACY_PAYMENT_REPORTS: 'true' }, loadConfig)), true);
});

test('the gcs storage driver requires a bucket', () => {
  assert.throws(
    () => withEnv({ STORAGE_DRIVER: 'gcs', GCS_BUCKET: undefined }, loadConfig),
    (err: Error) => err.message.includes('GCS_BUCKET'),
  );
  const config = withEnv({ STORAGE_DRIVER: 'gcs', GCS_BUCKET: 'ongo-test-uploads' }, loadConfig);
  assert.equal(config.STORAGE_DRIVER, 'gcs');
  assert.equal(config.GCS_BUCKET, 'ongo-test-uploads');
});
