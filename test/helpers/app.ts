import './env.js';
import { buildApp, type App } from '../../src/app.js';
import { hashPassword, initPasswordHashing } from '../../src/auth/password.js';
import type { TokenRole } from '../../src/auth/tokens.js';
import { insertUser, type UserRow } from '../../src/auth/users.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import type { Database } from '../../src/db/database.js';
import { createMemoryBus, type EventBus } from '../../src/events/bus.js';
import type { Storage } from '../../src/storage/storage.js';
import { createTestDatabase } from './db.js';
import { createMemoryStorage } from './storage.js';

export interface TestContext {
  app: App;
  db: Database;
  events: EventBus;
  /** Every password-reset code the app "delivered", newest last. */
  resetCodes: Array<{ email: string; code: string }>;
  close(): Promise<void>;
}

/** `storage` swaps the in-memory store for another driver, e.g. gcs against a fake Google. */
export async function createTestApp(options: { storage?: (config: AppConfig) => Storage } = {}): Promise<TestContext> {
  const config = loadConfig();
  await initPasswordHashing();
  const db = await createTestDatabase();
  const events = createMemoryBus();
  const resetCodes: TestContext['resetCodes'] = [];

  const app = await buildApp({
    config,
    db,
    events,
    storage: options.storage ? options.storage(config) : createMemoryStorage(config),
    codeDelivery: {
      async deliverPasswordResetCode({ email, code }) {
        resetCodes.push({ email, code });
      },
    },
  });
  await app.ready();

  return {
    app,
    db,
    events,
    resetCodes,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export async function createUser(
  db: Database,
  input: { email: string; password: string; role: TokenRole; firstName?: string; lastName?: string },
): Promise<UserRow> {
  const user = await insertUser(db, {
    email: input.email,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    firstName: input.firstName ?? 'Test',
    lastName: input.lastName ?? 'User',
  });
  if (input.role === 'moderator') {
    await db.query('INSERT INTO moderator_permissions (user_id) VALUES ($1)', [user.id]);
  }
  return user;
}

export interface SignedIn {
  accessToken: string;
  refreshToken?: string;
  cookie?: string;
  body: Record<string, unknown>;
}

export async function signInAs(
  app: App,
  email: string,
  password: string,
  surface: 'mobile' | 'console',
): Promise<SignedIn> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    payload: { identifier: email, password, surface },
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-in failed (${res.statusCode}): ${res.body}`);
  }
  const body = res.json() as Record<string, unknown> & { accessToken: string; refreshToken?: string };
  const cookie = res.cookies.find((c) => c.name === 'ongo_refresh')?.value;
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, cookie, body };
}

export function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}
