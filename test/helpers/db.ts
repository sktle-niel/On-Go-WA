import { PGlite, type Transaction } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { createQueryable, type Database, type Queryable } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * A real PostgreSQL, in memory, per test file: PGlite runs the actual
 * Postgres engine compiled to WebAssembly. The migrations and every query the
 * app makes run unchanged, so what passes here is what the SQL does — no mock
 * to drift from the database.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

type Executor = Pick<PGlite | Transaction, 'query' | 'exec'>;

function queryableOver(executor: Executor): Queryable {
  return createQueryable({
    query: (text, params) => executor.query(text, params as unknown[]),
    exec: (text) => executor.exec(text),
  });
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<Database> {
  const pglite = new PGlite();
  await pglite.waitReady;

  const db: Database = {
    ...queryableOver(pglite),
    withTransaction: (fn) => pglite.transaction((tx) => fn(queryableOver(tx))),
    ping: async () => true,
    close: () => pglite.close(),
  };

  if (options.migrate !== false) {
    await runMigrations(db, MIGRATIONS_DIR);
  }
  return db;
}
