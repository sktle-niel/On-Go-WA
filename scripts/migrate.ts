import { resolve } from 'node:path';
import { loadRemoteSecrets } from '../src/config/secrets.js';

/**
 * Applies pending migrations from ./migrations (relative to the working
 * directory) and exits. Run it as the schema owner, before the new API
 * version starts serving.
 */
async function main(): Promise<void> {
  await loadRemoteSecrets();
  const [{ loadConfig }, { createPgDatabase }, { runMigrations }] = await Promise.all([
    import('../src/config/env.js'),
    import('../src/db/database.js'),
    import('../src/db/migrate.js'),
  ]);

  const config = loadConfig();
  const db = createPgDatabase(config);
  try {
    const result = await runMigrations(db, resolve(process.cwd(), 'migrations'), {
      log: (message) => console.log(message),
    });
    console.log(`applied: ${result.applied.length > 0 ? result.applied.join(', ') : 'nothing new'}`);
    console.log(`already applied: ${result.skipped.length}`);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  const cause = (err as { cause?: unknown }).cause;
  const message =
    cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
  console.error(`migration failed: ${message}`);
  process.exit(1);
});
