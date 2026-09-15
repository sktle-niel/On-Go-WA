import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { PlatformEvent } from '../../src/events/bus.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let adminToken: string;
let mechToken: string; // approved mechanic
let mechId: string;
let unapprovedMechToken: string;

const events: PlatformEvent[] = [];
let seq = 0;

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin', firstName: 'Ada', lastName: 'Admin' });
  const mech = await createUser(ctx.db, { email: 'mech@example.com', password: 'mech password 1', role: 'mechanic', firstName: 'Mike', lastName: 'Mechanic' });
  mechId = mech.id;
  await createUser(ctx.db, { email: 'unapproved@example.com', password: 'unappr password 1', role: 'mechanic' });

  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
  mechToken = (await signInAs(ctx.app, 'mech@example.com', 'mech password 1', 'mobile')).accessToken;
  unapprovedMechToken = (await signInAs(ctx.app, 'unapproved@example.com', 'unappr password 1', 'mobile')).accessToken;

  // Approve the mechanic through the real verification flow (Step 5).
  const vr = await ctx.app.inject({ method: 'POST', url: '/api/v1/verification-requests', headers: bearer(mechToken), payload: { name: 'Mike Mechanic', email: 'mech@example.com', role: 'mechanic' } });
  await ctx.app.inject({ method: 'POST', url: `/api/v1/verification-requests/${vr.json().id}/decision`, headers: bearer(adminToken), payload: { action: 'approved' } });

  ctx.events.subscribe((e) => events.push(e));
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  events.length = 0;
});

/** A fresh client with one pending request of the given urgency. */
async function freshRequest(urgency: 'Normal' | 'Urgent' | 'Emergency'): Promise<{ id: string; clientId: string; token: string }> {
  seq += 1;
  const email = `client${seq}@example.com`;
  const client = await createUser(ctx.db, { email, password: 'a client password', role: 'client' });
  const token = (await signInAs(ctx.app, email, 'a client password', 'mobile')).accessToken;
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/service-requests', headers: bearer(token), payload: { problem: 'Flat tire', location: 'EDSA', urgency } });
  return { id: res.json().id, clientId: client.id, token };
}

const quote = (token: string, id: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${id}/quotes`, headers: bearer(token), payload: body });

const listQuotes = (token: string, id: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1/service-requests/${id}/quotes`, headers: bearer(token) });

test('an approved mechanic quotes; an unapproved one cannot', async () => {
  const req = await freshRequest('Normal');

  const unappr = await quote(unapprovedMechToken, req.id, { price: 500, etaMinutes: 30 });
  assert.equal(unappr.statusCode, 403);

  const res = await quote(mechToken, req.id, { price: 500, etaMinutes: 30 });
  assert.equal(res.statusCode, 201, res.body);
  const dto = res.json();
  assert.equal(dto.price, 500);
  assert.equal(dto.etaMinutes, 30);
  assert.equal(dto.mechanicName, 'Mike Mechanic');
  assert.equal(dto.accepted, false);

  // The client sees the live offer.
  const list = await listQuotes(req.token, req.id);
  assert.equal(list.json().length, 1);

  const event = events.find((e) => e.name === 'quote.submitted' && (e.data as { id: string }).id === dto.id);
  assert.ok(event);
  assert.deepEqual(event.audience?.userIds, [req.clientId]);
});

test('one live quote per mechanic per request', async () => {
  const req = await freshRequest('Normal');
  assert.equal((await quote(mechToken, req.id, { price: 400, etaMinutes: 20 })).statusCode, 201);
  const second = await quote(mechToken, req.id, { price: 450, etaMinutes: 25 });
  assert.equal(second.statusCode, 409);
});

test('the ETA must fit the completion window on an Urgent job', async () => {
  const req = await freshRequest('Urgent');
  const tooLong = await quote(mechToken, req.id, { price: 800, etaMinutes: 3 * 24 * 60 + 1 });
  assert.equal(tooLong.statusCode, 400);
  assert.equal(tooLong.json().error.code, 'bad_request');
  assert.equal((await quote(mechToken, req.id, { price: 800, etaMinutes: 120 })).statusCode, 201);
});

test('Emergency requests are accepted directly, not quoted', async () => {
  const req = await freshRequest('Emergency');
  const res = await quote(mechToken, req.id, { price: 900, etaMinutes: 30 });
  assert.equal(res.statusCode, 409);
});

test('a withdrawn quote can be sent again', async () => {
  const req = await freshRequest('Normal');
  assert.equal((await quote(mechToken, req.id, { price: 500, etaMinutes: 30 })).statusCode, 201);

  const withdraw = await ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${req.id}/quotes/withdraw`, headers: bearer(mechToken) });
  assert.equal(withdraw.statusCode, 200);
  assert.ok(withdraw.json().withdrawnAt);

  // The client no longer sees it.
  assert.equal((await listQuotes(req.token, req.id)).json().length, 0);

  // The mechanic may quote again.
  assert.equal((await quote(mechToken, req.id, { price: 550, etaMinutes: 40 })).statusCode, 201);
});

test('a rejected mechanic cannot re-quote, and sees their rejection', async () => {
  const req = await freshRequest('Normal');
  const q = (await quote(mechToken, req.id, { price: 600, etaMinutes: 45 })).json();

  const reject = await ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${req.id}/quotes/${q.id}/reject`, headers: bearer(req.token) });
  assert.equal(reject.statusCode, 200);
  assert.ok(reject.json().rejectedAt);

  // Re-quoting is refused.
  const again = await quote(mechToken, req.id, { price: 650, etaMinutes: 50 });
  assert.equal(again.statusCode, 409);

  // The mechanic still sees their own (rejected) quote; the client sees none live.
  const mine = await listQuotes(mechToken, req.id);
  assert.equal(mine.json().length, 1);
  assert.ok(mine.json()[0].rejectedAt);
  assert.equal((await listQuotes(req.token, req.id)).json().length, 0);
});

test('only the request owner can reject a quote', async () => {
  const req = await freshRequest('Normal');
  const q = (await quote(mechToken, req.id, { price: 500, etaMinutes: 30 })).json();
  const other = await freshRequest('Normal'); // a different client
  const reject = await ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${req.id}/quotes/${q.id}/reject`, headers: bearer(other.token) });
  assert.equal(reject.statusCode, 404);
});
