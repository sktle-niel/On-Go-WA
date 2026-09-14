import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * Pulls secrets out of AWS Secrets Manager and folds them into process.env
 * BEFORE the env schema is validated, so the rest of the app only ever reads
 * config from one place.
 *
 * Nothing here is ever logged. Values fetched are merged only when the key is
 * not already present in the environment, so a locally exported value can
 * shadow a remote one during development without editing code.
 *
 * Two secrets are supported:
 *   APP_SECRETS_ARN — JSON blob of application secrets (JWT keys, pepper...)
 *   DB_SECRET_ARN   — the RDS-managed rotating credential secret
 *                     ({ username, password, host, port, dbname })
 *
 * When neither is set (local dev) this is a no-op and plain env vars are used.
 */

let client: SecretsManagerClient | null = null;

function getClient(): SecretsManagerClient {
  if (!client) {
    client = new SecretsManagerClient({
      region: process.env.AWS_REGION ?? 'ap-southeast-1',
      maxAttempts: 4,
    });
  }
  return client;
}

async function fetchSecretJson(arn: string): Promise<Record<string, unknown>> {
  const res = await getClient().send(new GetSecretValueCommand({ SecretId: arn }));
  const raw = res.SecretString;
  if (!raw) {
    // Binary secrets are not a supported shape for this service.
    throw new Error('Secret has no string value');
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Secret must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Merge without clobbering anything already exported in the environment. */
function mergeIntoEnv(values: Record<string, unknown>, mapping?: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    const envKey = mapping?.[key] ?? key;
    if (process.env[envKey] === undefined) {
      process.env[envKey] = String(value);
    }
  }
}

/**
 * Resolves every remote secret. Throws on failure: a service that cannot read
 * its credentials must refuse to start rather than fall back to a weaker
 * configuration.
 */
export async function loadRemoteSecrets(): Promise<void> {
  const appArn = process.env.APP_SECRETS_ARN;
  const dbArn = process.env.DB_SECRET_ARN;

  if (appArn) {
    mergeIntoEnv(await fetchSecretJson(appArn));
  }

  if (dbArn) {
    // Field names below are the ones RDS/Secrets Manager rotation writes.
    mergeIntoEnv(await fetchSecretJson(dbArn), {
      username: 'PGUSER',
      password: 'PGPASSWORD',
      host: 'PGHOST',
      port: 'PGPORT',
      dbname: 'PGDATABASE',
      engine: 'PGENGINE',
    });
  }
}
