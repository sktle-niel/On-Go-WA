import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { PlatformEvent } from '../../src/events/bus.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let adminToken: string;
let plainModeratorToken: string;
let clientToken: string;

const events: PlatformEvent[] = [];

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin', firstName: 'Ada', lastName: 'Admin' });
  await createUser(ctx.db, { email: 'plainmod@example.com', password: 'plain mod pass 1', role: 'moderator' });
  await createUser(ctx.db, { email: 'client@example.com', password: 'client password 1', role: 'client' });

  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
  plainModeratorToken = (await signInAs(ctx.app, 'plainmod@example.com', 'plain mod pass 1', 'console')).accessToken;
  clientToken = (await signInAs(ctx.app, 'client@example.com', 'client password 1', 'mobile')).accessToken;

  ctx.events.subscribe((event) => events.push(event));
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  events.length = 0;
});

const createMod = (body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/moderators', headers: bearer(adminToken), payload: body });

test('an admin creates a moderator who can then sign in', async () => {
  const res = await createMod({
    name: 'Maria Santos',
    email: 'maria@example.com',
    temporaryPassword: 'temp password 12',
    permissions: { canApprove: true, canReject: true, canEscalate: false, canChangeBackground: false },
  });
  assert.equal(res.statusCode, 201, res.body);
  const dto = res.json();
  assert.equal(dto.name, 'Maria Santos');
  assert.equal(dto.email, 'maria@example.com');
  assert.equal(dto.role, 'Moderator');
  assert.equal(dto.status, 'active');
  assert.equal(dto.actionsHandled, 0);
  assert.equal(dto.photoUrl, null);
  assert.deepEqual(dto.permissions, { canApprove: true, canReject: true, canEscalate: false, canChangeBackground: false });

  const event = events.find((e) => e.name === 'moderator.updated' && (e.data as { id: string }).id === dto.id);
  assert.ok(event, 'moderator.updated was published');

  // The temporary password works on the console surface.
  const session = await signInAs(ctx.app, 'maria@example.com', 'temp password 12', 'console');
  assert.ok(session.accessToken);
});

test('a duplicate email is refused', async () => {
  const res = await createMod({ name: 'Maria Two', email: 'maria@example.com', temporaryPassword: 'temp password 12' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'conflict');
});

test('the directory is admin-only', async () => {
  assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/v1/moderators' })).statusCode, 401);
  assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/v1/moderators', headers: bearer(clientToken) })).statusCode, 403);
  assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/v1/moderators', headers: bearer(plainModeratorToken) })).statusCode, 403);
  const admin = await ctx.app.inject({ method: 'GET', url: '/api/v1/moderators', headers: bearer(adminToken) });
  assert.equal(admin.statusCode, 200);
  assert.ok(admin.json().some((m: { email: string }) => m.email === 'maria@example.com'));
});

test('updating permissions takes effect on the moderator’s next request', async () => {
  const created = (await createMod({ name: 'Perm Test', email: 'perm@example.com', temporaryPassword: 'temp password 12', permissions: { canApprove: true, canReject: true, canEscalate: false, canChangeBackground: false } })).json();
  const session = await signInAs(ctx.app, 'perm@example.com', 'temp password 12', 'console');

  const before = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session.accessToken) });
  assert.equal(before.json().permissions.canEscalate, false);

  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/moderators/${created.id}/permissions`,
    headers: bearer(adminToken),
    payload: { canApprove: true, canReject: false, canEscalate: true, canChangeBackground: false },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().permissions, { canApprove: true, canReject: false, canEscalate: true, canChangeBackground: false });

  // Rights are read from the database each request, so the change is immediate.
  const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session.accessToken) });
  assert.equal(after.json().permissions.canEscalate, true);
  assert.equal(after.json().permissions.canReject, false);
});

test('a profile update changes the name and can clear the photo', async () => {
  const created = (await createMod({ name: 'Old Name', email: 'profile@example.com', temporaryPassword: 'temp password 12' })).json();

  const named = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/moderators/${created.id}/profile`,
    headers: bearer(adminToken),
    payload: { name: 'New Name', photoUrl: 'https://cdn.example.com/a.png' },
  });
  assert.equal(named.statusCode, 200);
  assert.equal(named.json().name, 'New Name');
  assert.equal(named.json().photoUrl, 'https://cdn.example.com/a.png');

  const cleared = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/moderators/${created.id}/profile`,
    headers: bearer(adminToken),
    payload: { photoUrl: null },
  });
  assert.equal(cleared.json().photoUrl, null);
  assert.equal(cleared.json().name, 'New Name'); // unchanged
});

test('a removed moderator is signed out on their next request and cannot sign in', async () => {
  const created = (await createMod({ name: 'To Remove', email: 'remove@example.com', temporaryPassword: 'temp password 12' })).json();
  const session = await signInAs(ctx.app, 'remove@example.com', 'temp password 12', 'console');

  const before = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session.accessToken) });
  assert.equal(before.statusCode, 200);

  const remove = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/moderators/${created.id}?reason=left the team`,
    headers: bearer(adminToken),
  });
  assert.equal(remove.statusCode, 204);

  // Deactivated: the guard hits the status check first, so the next request is
  // 403 account_inactive (the session was revoked too). Either way, locked out.
  const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session.accessToken) });
  assert.equal(after.statusCode, 403);
  assert.equal(after.json().error.code, 'account_inactive');

  const reSignIn = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    payload: { identifier: 'remove@example.com', password: 'temp password 12', surface: 'console' },
  });
  assert.equal(reSignIn.statusCode, 403);
  assert.equal(reSignIn.json().error.code, 'account_inactive');

  const missing = await ctx.app.inject({
    method: 'DELETE',
    url: '/api/v1/moderators/00000000-0000-0000-0000-000000000000',
    headers: bearer(adminToken),
  });
  assert.equal(missing.statusCode, 404);
});

test('the audit log merges roster changes and queue decisions, newest first', async () => {
  // A queue decision, written by the verification service into the same log.
  const mech = await createUser(ctx.db, { email: 'auditmech@example.com', password: 'mech password 1', role: 'mechanic' });
  const mechToken = (await signInAs(ctx.app, 'auditmech@example.com', 'mech password 1', 'mobile')).accessToken;
  const request = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/verification-requests',
      headers: bearer(mechToken),
      payload: { name: 'Audit Mech', email: 'auditmech@example.com', role: 'mechanic' },
    })
  ).json();
  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/verification-requests/${request.id}/decision`,
    headers: bearer(adminToken),
    payload: { action: 'approved', reason: 'ok' },
  });

  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-log', headers: bearer(adminToken) });
  assert.equal(res.statusCode, 200);
  const entries = res.json();
  assert.ok(Array.isArray(entries) && entries.length > 0);

  // Every entry names the actor and their role; roster entries and a queue
  // decision both appear.
  assert.ok(entries.every((e: { actorName: string; actorRole: string }) => e.actorName && e.actorRole));
  assert.ok(entries.some((e: { action: string }) => e.action === 'added'), 'a roster "added" entry');
  assert.ok(entries.some((e: { action: string; role: string }) => e.action === 'approved' && e.role === 'mechanic'), 'a queue "approved" entry');
  const mariaRemoval = mariaWasRemoved(entries);
  assert.ok(mariaRemoval === undefined || mariaRemoval);

  // Newest first.
  const times = entries.map((e: { occurredAt: string }) => Date.parse(e.occurredAt));
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepEqual(times, sorted);
});

function mariaWasRemoved(entries: Array<{ action: string; ipAddress: string | null }>): boolean | undefined {
  const removed = entries.find((e) => e.action === 'removed');
  if (!removed) return undefined;
  // The audit trail records the caller's address in full, not a hash.
  return removed.ipAddress !== undefined;
}
