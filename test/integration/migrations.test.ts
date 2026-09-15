import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Database } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createTestDatabase, MIGRATIONS_DIR } from '../helpers/db.js';

let db: Database;

before(async () => {
  db = await createTestDatabase({ migrate: false });
});

after(async () => {
  await db.close();
});

test('applies every migration once, in order, and then nothing', async () => {
  const first = await runMigrations(db, MIGRATIONS_DIR);
  assert.deepEqual(first.applied, [
    '001_init',
    '002_roles_least_privilege',
    '003_audit_actor_role_and_ip',
    '004_contract_alignment',
    '005_verification_requests',
    '006_service_requests',
    '007_quotes',
    '008_accept',
    '009_job_progress',
    '010_payments_points',
    '011_cancel_expiry',
    '012_locations',
  ]);
  assert.deepEqual(first.skipped, []);

  const second = await runMigrations(db, MIGRATIONS_DIR);
  assert.deepEqual(second.applied, []);
  assert.equal(second.skipped.length, 12);
});

test('the contract tables exist with their seed rows', async () => {
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const names = tables.map((row) => row.table_name);
  for (const expected of [
    'users',
    'sessions',
    'login_attempts',
    'security_events',
    'moderator_permissions',
    'account_requests',
    'account_request_documents',
    'admin_audit_log',
    'moderator_activity',
    'points_policy',
    'platform_appearance',
    'revenue_ledger',
    'points_ledger',
    'user_locations',
    'password_reset_codes',
    'schema_migrations',
  ]) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }

  const policy = await db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM points_policy');
  assert.equal(policy?.n, 1);
  const appearance = await db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM platform_appearance');
  assert.equal(appearance?.n, 1);

  const column = await db.queryOne<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'moderator_permissions' AND column_name = 'can_change_background'`,
  );
  assert.ok(column, 'moderator_permissions.can_change_background is missing');
});

test('the least-privilege roles exist', async () => {
  const roles = await db.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname LIKE 'ongo_%' ORDER BY rolname`,
  );
  assert.deepEqual(
    roles.map((row) => row.rolname),
    ['ongo_app', 'ongo_migrator', 'ongo_readonly'],
  );
});

test('the points ledger is append-only for the application role, and the retired revenue ledger read-only', async () => {
  const grants = await db.queryOne<Record<string, boolean>>(
    `SELECT has_table_privilege('ongo_app', 'points_ledger', 'INSERT') AS ledger_insert,
            has_table_privilege('ongo_app', 'points_ledger', 'UPDATE') AS ledger_update,
            has_table_privilege('ongo_app', 'points_ledger', 'DELETE') AS ledger_delete,
            has_table_privilege('ongo_app', 'revenue_ledger', 'SELECT') AS revenue_select,
            has_table_privilege('ongo_app', 'revenue_ledger', 'INSERT') AS revenue_insert`,
  );
  assert.deepEqual(grants, {
    ledger_insert: true,
    ledger_update: false,
    ledger_delete: false,
    revenue_select: true,
    revenue_insert: false,
  });
});
