import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { AppConfig } from '../config/env.js';
import { logger } from '../logging/logger.js';
import { internalError, isAppError } from '../utils/errors.js';

const { Pool } = pg;

/**
 * The only sanctioned way to talk to the database.
 *
 * `text` must be a static SQL string and every runtime value must arrive
 * through `params` as a $1/$2 placeholder. That is what makes SQL injection
 * structurally impossible here rather than a review checklist item: the driver
 * sends the statement and the arguments over the wire separately, so a value
 * is never parsed as SQL no matter what it contains.
 *
 * If you ever need a dynamic column or direction (ORDER BY cannot be
 * parameterized), run it through `safeIdentifier` / `safeSortDirection` — those
 * map untrusted input onto a fixed allowlist rather than interpolating it.
 *
 * The interface is deliberately small so a test can back it with an in-memory
 * PostgreSQL (PGlite) and exercise the real SQL without a server.
 */

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends object = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Exactly one row expected; returns null when there is none. */
  queryOne<T extends object = Row>(text: string, params?: readonly unknown[]): Promise<T | null>;
  /** Runs a multi-statement SQL script with no parameters (migrations only). */
  exec(text: string): Promise<void>;
}

export interface Database extends Queryable {
  /**
   * Runs `fn` inside a transaction, rolling back on any throw. Used wherever a
   * security decision spans more than one statement — rotating a refresh
   * token, for instance, must revoke the old row and insert the new one
   * atomically or not at all.
   */
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Rejects a template-built string before it can reach the driver. */
function assertStaticSql(text: string): void {
  // A parameterized statement never needs a quoted literal built at runtime.
  // This does not prove safety, but it catches the common regression where
  // someone reintroduces `WHERE email = '${email}'`.
  if (/\$\{/.test(text)) {
    throw internalError(new Error('SQL contains a template interpolation'), {
      reason: 'non_parameterized_sql',
    });
  }
}

function wrapDriverError(err: unknown, stage: string): never {
  if (isAppError(err)) throw err;
  // The driver's message can quote the failing statement and its values.
  // Log it; never let it propagate to a response.
  logger.error(
    { err: { name: (err as Error).name, message: (err as Error).message }, stage },
    'database operation failed',
  );
  throw internalError(err, { stage });
}

export interface RawExecutor {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  exec(text: string): Promise<unknown>;
}

/** Builds the guarded Queryable surface over any driver with a pg-like query(). */
export function createQueryable(raw: RawExecutor): Queryable {
  return {
    async query<T extends object = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      assertStaticSql(text);
      try {
        const result = await raw.query(text, params);
        return result.rows as T[];
      } catch (err) {
        return wrapDriverError(err, 'query');
      }
    },
    async queryOne<T extends object = Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<T | null> {
      const rows = await this.query<T>(text, params);
      return rows[0] ?? null;
    },
    async exec(text: string): Promise<void> {
      try {
        await raw.exec(text);
      } catch (err) {
        return wrapDriverError(err, 'exec');
      }
    },
  };
}

function resolveCaCert(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Accept either an inline PEM (how Secrets Manager delivers it) or a path
  // (how a container mount delivers it).
  if (raw.includes('-----BEGIN CERTIFICATE-----')) return raw;
  return readFileSync(raw, 'utf8');
}

function buildSslConfig(config: AppConfig): pg.PoolConfig['ssl'] {
  const ca = resolveCaCert(config.PG_CA_CERT);
  switch (config.PGSSLMODE) {
    case 'disable':
      return false;
    case 'require':
      // Encrypted, but the server identity is not checked. Local use only.
      return { rejectUnauthorized: false };
    case 'verify-ca':
      return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case 'verify-full':
    default:
      // Verifies the certificate chain against the CA bundle AND checks the
      // hostname. `require` alone encrypts but authenticates nothing.
      return { ca, rejectUnauthorized: true };
  }
}

/**
 * The production database: a pg connection pool.
 *
 * The pool connects as the least-privileged application role, never as the
 * master user — see migrations/002_roles_least_privilege.sql.
 */
export function createPgDatabase(config: AppConfig): Database {
  const pool = new Pool({
    host: config.PGHOST,
    port: config.PGPORT,
    database: config.PGDATABASE,
    user: config.PGUSER,
    password: config.PGPASSWORD,
    ssl: buildSslConfig(config),
    max: config.PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'ongo-api',
    // A runaway query holds a connection and a row lock; cap it server-side so
    // a single expensive or hostile request cannot exhaust the pool.
    statement_timeout: config.PG_STATEMENT_TIMEOUT_MS,
    query_timeout: config.PG_STATEMENT_TIMEOUT_MS,
  });

  // An idle client erroring (failover, RDS restart) must not take the process
  // down; pg re-creates the connection on next use.
  pool.on('error', (err) => {
    logger.error({ err: { name: err.name, message: err.message } }, 'idle database client error');
  });

  const base = createQueryable({
    query: (text, params) => pool.query(text, params as unknown[]),
    exec: (text) => pool.query(text),
  });

  return {
    ...base,
    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect().catch((err) => wrapDriverError(err, 'connect'));
      const tx = createQueryable({
        query: (text, params) => client.query(text, params as unknown[]),
        exec: (text) => client.query(text),
      });
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          logger.error(
            { err: { message: (rollbackErr as Error).message } },
            'transaction rollback failed',
          );
        }
        return wrapDriverError(err, 'transaction');
      } finally {
        client.release();
      }
    },
    async ping(): Promise<boolean> {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch (err) {
        logger.warn({ err: { message: (err as Error).message } }, 'database ping failed');
        return false;
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Maps caller-supplied sort input onto an allowlist. Identifiers cannot be
 * bound as parameters, so the only safe construction is selecting from a fixed
 * set we wrote ourselves — never quoting or escaping the input.
 */
export function safeIdentifier<T extends string>(
  candidate: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof candidate === 'string' && (allowed as readonly string[]).includes(candidate)
    ? (candidate as T)
    : fallback;
}

export function safeSortDirection(candidate: unknown): 'ASC' | 'DESC' {
  return typeof candidate === 'string' && candidate.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

/**
 * Neutralises LIKE wildcards (%, _, \) in a caller's search term, so a search
 * is a literal substring match and cannot be turned into "match everything".
 * Pair it with `ESCAPE '\'` in the query.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}
