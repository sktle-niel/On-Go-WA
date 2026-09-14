import { loadRemoteSecrets } from '../src/config/secrets.js';

/**
 * Creates the first admin account. Refuses to run when an admin already
 * exists unless --force is given, so it is safe to leave in a deploy script.
 *
 *   npm run seed:admin -- --email admin@example.com --password '…' --name 'Ada Admin'
 *
 * or via SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME.
 */

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  await loadRemoteSecrets();

  const email = argValue('--email') ?? process.env.SEED_ADMIN_EMAIL;
  const password = argValue('--password') ?? process.env.SEED_ADMIN_PASSWORD;
  const name = argValue('--name') ?? process.env.SEED_ADMIN_NAME ?? 'Administrator';
  const force = process.argv.includes('--force');

  if (!email || !password) {
    console.error('usage: seed-admin --email <email> --password <password> [--name <name>] [--force]');
    process.exit(2);
  }
  if (password.length < 12) {
    console.error('the admin password must be at least 12 characters');
    process.exit(2);
  }

  const [{ loadConfig }, { createPgDatabase }, { hashPassword }, { findUserByEmail, insertUser }] =
    await Promise.all([
      import('../src/config/env.js'),
      import('../src/db/database.js'),
      import('../src/auth/password.js'),
      import('../src/auth/users.js'),
    ]);

  const db = createPgDatabase(loadConfig());
  try {
    const admins = await db.queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE role = 'admin'::user_role AND status = 'active'`,
    );
    if ((admins?.n ?? 0) > 0 && !force) {
      console.log('an active admin already exists; pass --force to add another');
      return;
    }
    if (await findUserByEmail(db, email)) {
      console.error('an account with that email already exists');
      process.exit(1);
    }

    const [firstName, ...rest] = name.trim().split(/\s+/);
    const user = await insertUser(db, {
      email,
      passwordHash: await hashPassword(password),
      role: 'admin',
      firstName: firstName ?? 'Administrator',
      lastName: rest.join(' '),
    });
    console.log(`created admin ${user.email} (${user.id})`);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  const cause = (err as { cause?: unknown }).cause;
  const message =
    cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
  console.error(`seed failed: ${message}`);
  process.exit(1);
});
