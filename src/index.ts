import { loadRemoteSecrets } from './config/secrets.js';

/**
 * Process entry point.
 *
 * Secrets are pulled into the environment BEFORE anything reads
 * configuration, which is why the rest of the app is imported dynamically:
 * a static import would validate config at load time, ahead of the secrets.
 */
async function main(): Promise<void> {
  await loadRemoteSecrets();
  const { bootstrap } = await import('./bootstrap.js');
  await bootstrap();
}

main().catch((err: unknown) => {
  // Configuration errors name only the offending keys, never the values.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
