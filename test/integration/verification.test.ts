import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { PlatformEvent } from '../../src/events/bus.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let adminToken: string;
let moderatorToken: string; // can approve + reject, NOT escalate (the created default)
let mechanicToken: string;
let mechanicId: string;
let otherMechanicToken: string;
let clientToken: string;

const events: PlatformEvent[] = [];

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin', firstName: 'Ada', lastName: 'Admin' });
  await createUser(ctx.db, { email: 'mod@example.com', password: 'mod password 1', role: 'moderator', firstName: 'Mo', lastName: 'Derator' });
  const mech = await createUser(ctx.db, { email: 'mech@example.com', password: 'mech password 1', role: 'mechanic' });
  mechanicId = mech.id;
  await createUser(ctx.db, { email: 'other@example.com', password: 'other password 1', role: 'mechanic' });
  await createUser(ctx.db, { email: 'client@example.com', password: 'client password 1', role: 'client' });

  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
  moderatorToken = (await signInAs(ctx.app, 'mod@example.com', 'mod password 1', 'console')).accessToken;
  mechanicToken = (await signInAs(ctx.app, 'mech@example.com', 'mech password 1', 'mobile')).accessToken;
  otherMechanicToken = (await signInAs(ctx.app, 'other@example.com', 'other password 1', 'mobile')).accessToken;
  clientToken = (await signInAs(ctx.app, 'client@example.com', 'client password 1', 'mobile')).accessToken;

  ctx.events.subscribe((event) => events.push(event));
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  events.length = 0;
});

const submit = (token: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/verification-requests', headers: bearer(token), payload: body });

const decide = (token: string, id: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/verification-requests/${id}/decision`, headers: bearer(token), payload: body });

// A fresh mechanic per scenario so the one-pending-per-user rule never collides.
async function freshMechanic(tag: string): Promise<{ id: string; token: string }> {
  const email = `mech-${tag}@example.com`;
  const user = await createUser(ctx.db, { email, password: 'a mechanic password', role: 'mechanic' });
  const token = (await signInAs(ctx.app, email, 'a mechanic password', 'mobile')).accessToken;
  return { id: user.id, token };
}

test('a mechanic files a request and it comes back as a pending DTO', async () => {
  const res = await submit(mechanicToken, {
    name: 'Juan Dela Cruz',
    email: 'juan@example.com',
    role: 'mechanic',
    documentNames: ['ID front', 'ID back'],
  });
  assert.equal(res.statusCode, 201, res.body);
  const dto = res.json();
  assert.match(dto.userNumber, /^ONG-\d{6}$/);
  assert.equal(dto.status, 'pending');
  assert.equal(dto.escalated, false);
  assert.equal(dto.name, 'Juan Dela Cruz');
  assert.equal(dto.email, 'juan@example.com');
  assert.equal(dto.role, 'mechanic');
  assert.deepEqual(dto.documentNames, ['ID front', 'ID back']);
  assert.deepEqual(dto.documents, []);
  assert.equal(dto.reason, null);
  assert.equal(dto.reviewedAt, null);
  assert.equal(dto.reviewerName, null);

  // The owner and the console see the new request on the socket.
  const event = events.find((e) => e.name === 'verification_request.updated');
  assert.ok(event, 'a verification_request.updated event was published');
  assert.equal((event.data as { id: string }).id, dto.id);
  assert.deepEqual(event.audience?.userIds, [mechanicId]);
  assert.deepEqual(event.audience?.roles, ['admin', 'moderator']);
});

test('a second pending request from the same account is refused', async () => {
  const res = await submit(mechanicToken, { name: 'Juan Again', email: 'juan@example.com', role: 'mechanic' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'conflict');
});

test('the queue is console-only', async () => {
  assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/v1/verification-requests' })).statusCode, 401);
  assert.equal(
    (await ctx.app.inject({ method: 'GET', url: '/api/v1/verification-requests', headers: bearer(clientToken) })).statusCode,
    403,
  );
  assert.equal(
    (await ctx.app.inject({ method: 'GET', url: '/api/v1/verification-requests', headers: bearer(mechanicToken) })).statusCode,
    403,
  );
  const admin = await ctx.app.inject({ method: 'GET', url: '/api/v1/verification-requests', headers: bearer(adminToken) });
  assert.equal(admin.statusCode, 200);
  assert.ok(Array.isArray(admin.json()) && admin.json().length >= 1);
});

test('the queue filters by status, escalation and search', async () => {
  const q = (query: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/verification-requests?${query}`, headers: bearer(adminToken) });

  assert.ok((await q('status=pending')).json().length >= 1);
  assert.deepEqual((await q('status=approved')).json(), []);
  assert.deepEqual((await q('escalatedOnly=true')).json(), []);
  const byName = (await q('search=Juan')).json();
  assert.ok(byName.length >= 1 && byName.every((r: { name: string }) => /juan/i.test(r.name)));
  assert.deepEqual((await q('search=nobody-matches-this')).json(), []);
  // A bare '%' is a literal here, not a wildcard: it matches nothing, not all.
  assert.deepEqual((await q('search=%25')).json(), []);
});

test('ownership: a mechanic sees only their own request', async () => {
  const submitted = (await submit(otherMechanicToken, { name: 'Other Mech', email: 'other@example.com', role: 'mechanic' })).json();

  const owner = await ctx.app.inject({ method: 'GET', url: `/api/v1/verification-requests/${submitted.id}`, headers: bearer(otherMechanicToken) });
  assert.equal(owner.statusCode, 200);

  const stranger = await ctx.app.inject({ method: 'GET', url: `/api/v1/verification-requests/${submitted.id}`, headers: bearer(mechanicToken) });
  assert.equal(stranger.statusCode, 404);

  const console = await ctx.app.inject({ method: 'GET', url: `/api/v1/verification-requests/${submitted.id}`, headers: bearer(adminToken) });
  assert.equal(console.statusCode, 200);

  const missing = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/verification-requests/00000000-0000-0000-0000-000000000000',
    headers: bearer(adminToken),
  });
  assert.equal(missing.statusCode, 404);
});

test('an admin approves: the verdict is recorded, streamed, and cannot be repeated', async () => {
  const mech = await freshMechanic('approve');
  const request = (await submit(mech.token, { name: 'To Approve', email: 'approve@example.com', role: 'mechanic' })).json();

  const res = await decide(adminToken, request.id, { action: 'approved', reason: 'documents check out' });
  assert.equal(res.statusCode, 200, res.body);
  const dto = res.json();
  assert.equal(dto.status, 'approved');
  assert.equal(dto.reason, 'documents check out');
  assert.ok(dto.reviewedAt);
  assert.equal(dto.reviewerName, 'Ada Admin');

  // Streamed to the owner. Submit also published for this id, so pick the
  // event carrying the decision, not the earlier pending one.
  const event = events.find(
    (e) =>
      e.name === 'verification_request.updated' &&
      (e.data as { id: string }).id === request.id &&
      (e.data as { status: string }).status === 'approved',
  );
  assert.ok(event);
  assert.deepEqual(event.audience?.userIds, [mech.id]);

  // In the activity feed.
  const activity = await ctx.app.inject({ method: 'GET', url: '/api/v1/moderation/activity', headers: bearer(adminToken) });
  assert.equal(activity.statusCode, 200);
  const entry = activity.json().find((a: { requestId: string }) => a.requestId === request.id);
  assert.ok(entry);
  assert.equal(entry.action, 'approved');
  assert.equal(entry.moderatorName, 'Ada Admin');

  // A second decision on a decided request is a conflict.
  const again = await decide(adminToken, request.id, { action: 'rejected' });
  assert.equal(again.statusCode, 409);
});

test('permissions: a moderator can reject but not escalate', async () => {
  const mech = await freshMechanic('reject');
  const request = (await submit(mech.token, { name: 'To Reject', email: 'reject@example.com', role: 'mechanic' })).json();

  const escalate = await decide(moderatorToken, request.id, { action: 'escalated' });
  assert.equal(escalate.statusCode, 403);
  assert.equal(escalate.json().error.code, 'forbidden');

  const reject = await decide(moderatorToken, request.id, { action: 'rejected', reason: 'blurry ID' });
  assert.equal(reject.statusCode, 200);
  assert.equal(reject.json().status, 'rejected');
  assert.equal(reject.json().reason, 'blurry ID');
});

test('escalation keeps the request pending but flags it for an admin', async () => {
  const mech = await freshMechanic('escalate');
  const request = (await submit(mech.token, { name: 'To Escalate', email: 'escalate@example.com', role: 'business' })).json();

  const res = await decide(adminToken, request.id, { action: 'escalated', reason: 'needs a second look' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().escalated, true);
  assert.equal(res.json().status, 'pending');

  const escalated = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/verification-requests?escalatedOnly=true',
    headers: bearer(adminToken),
  });
  assert.ok(escalated.json().some((r: { id: string }) => r.id === request.id));

  // An admin can still approve an escalated request.
  const approve = await decide(adminToken, request.id, { action: 'approved' });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().status, 'approved');
});

test('the actor of a decision is the token holder, not the body', async () => {
  const mech = await freshMechanic('actor');
  const request = (await submit(mech.token, { name: 'Actor Test', email: 'actor@example.com', role: 'mechanic' })).json();

  const res = await decide(adminToken, request.id, {
    action: 'approved',
    actorName: 'Someone Else',
    actorId: '11111111-1111-1111-1111-111111111111',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reviewerName, 'Ada Admin');
});
