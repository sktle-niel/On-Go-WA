import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from './database.js';

/**
 * Forward-only SQL migrations.
 *
 * Each `migrations/NNN_name.sql` runs once, inside its own transaction, and is
 * recorded in `schema_migrations` under its file name. Files must not contain
 * their own BEGIN/COMMIT. There is no "down": a change that must be undone is
 * a new migration, which is the only kind of rollback that is also audited.
 */

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface MigrationOptions {
  /** Restrict to some files (tests use it to leave role management out). */
  include?: (version: string) => boolean;
  log?: (message: string) => void;
}

export async function listMigrations(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export async function runMigrations(
  db: Database,
  dir: string,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const log = options.log ?? (() => undefined);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const done = new Set(
    (await db.query<{ version: string }>('SELECT version FROM schema_migrations')).map(
      (row) => row.version,
    ),
  );

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of await listMigrations(dir)) {
    const version = file.replace(/\.sql$/i, '');
    if (done.has(version) || (options.include && !options.include(version))) {
      result.skipped.push(version);
      continue;
    }

    const sql = await readFile(join(dir, file), 'utf8');
    if (/^\s*(BEGIN|COMMIT)\s*;/im.test(sql)) {
      throw new Error(`${file} manages its own transaction; the runner does that`);
    }

    log(`applying ${version}`);
    await db.withTransaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    });
    result.applied.push(version);
  }

  return result;
}
