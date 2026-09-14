import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Writes openapi/openapi.json from the route schemas, with no database and no
 * secrets: the document is a property of the code, not of an environment.
 * Hand the file to the front-end developer, or feed it to a client generator.
 *
 * The signing key and pepper below only exist to satisfy config validation so
 * the app can boot far enough to emit its schema; their values never reach the
 * output. They are generated at runtime, not written as literals, so no
 * secret-shaped string sits in the source.
 */

const defaults: Record<string, string> = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: randomBytes(48).toString('base64url'),
  PASSWORD_PEPPER: randomBytes(24).toString('base64url'),
  PGHOST: 'localhost',
  PGDATABASE: 'ongo',
  PGUSER: 'ongo',
  PGPASSWORD: 'placeholder',
  PGSSLMODE: 'disable',
};
for (const [key, fallback] of Object.entries(defaults)) {
  process.env[key] ??= fallback;
}

async function main(): Promise<void> {
  const [{ buildApp }, { loadConfig }, { createMemoryBus }] = await Promise.all([
    import('../src/app.js'),
    import('../src/config/env.js'),
    import('../src/events/bus.js'),
  ]);
  type Database = import('../src/db/database.js').Database;

  const nullDb: Database = {
    query: async () => [],
    queryOne: async () => null,
    exec: async () => undefined,
    withTransaction: async (fn) => fn(nullDb),
    ping: async () => false,
    close: async () => undefined,
  };

  const app = await buildApp({ config: loadConfig(), db: nullDb, events: createMemoryBus() });
  await app.ready();
  const document = app.swagger();
  await app.close();

  const outDir = resolve(process.cwd(), 'openapi');
  await mkdir(outDir, { recursive: true });
  const outFile = resolve(outDir, 'openapi.json');
  await writeFile(outFile, JSON.stringify(document, null, 2) + '\n', 'utf8');

  const paths = Object.keys((document as { paths?: Record<string, unknown> }).paths ?? {});
  console.log(`wrote ${outFile} (${paths.length} paths)`);
}

main().catch((err: unknown) => {
  console.error(`openapi export failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
