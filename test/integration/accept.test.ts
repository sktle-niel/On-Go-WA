import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { PlatformEvent } from '../../src/events/bus.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let adminToken: string;
let mechAToken: string;
let mechAId: string;
let mechBToken: string;

const events: PlatformEvent[] = [];
let seq = 0;

async function approveMechanic(email: string, name: string): Promise<{ id: string; token: string }> {
  const user = await createUser(ctx.db, { email, password: 'a mech password', role: 'mechanic', firstName: name, lastName: 'Mech' });
  const token = (await signInAs(ctx.app, email, 'a mech password', 'mobile')).accessToken;
  const vr = await ctx.app.inject({ method: 'POST', url: '/api/v1/verification-requests', headers: bearer(token), payload: { name, email, role: 'mechanic' } });
  await ctx.app.inject({ method: 'POST', url: `/api/v1/verification-requests/${vr.json().id}/decision`, headers: bearer(adminToken), payload: { action: 'approved' } });
  return { id: user.id, token };
}

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin' });
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
  const a = await approveMechanic('mecha@example.com', 'Alan');
  mechAToken = a.token;
  mechAId = a.id;
  mechBToken = (await approveMechanic('mechb@example.com', 'Bern')).token;
  ctx.events.subscribe((e) => events.push(e));
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  events.length = 0;
});

async function freshClient(urgency: 'Normal' | 'Urgent' | 'Emergency'): Promise<{ id: string; clientId: string; token: string }> {
  seq += 1;
  const email = `client${seq}@example.com`;
  const client = await createUser(ctx.db, { email, password: 'a client password', role: 'client' });
  const token = (await signInAs(ctx.app, email, 'a client password', 'mobile')).accessToken;
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/service-requests', headers: bearer(token), payload: { problem: 'Wont start', location: 'EDSA', urgency } });
  return { id: res.json().id, clientId: client.id, token };
}

const quote = (token: string, id: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${id}/quotes`, headers: bearer(token), payload: body });
const acceptQuote = (token: string, id: string, quoteId: string) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${id}/quotes/${quoteId}/accept`, headers: bearer(token) });
const acceptEmergency = (token: string, id: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${id}/accept`, headers: bearer(token), payload: body });

test('accepting a quote matches the request to that mechanic', async () => {
  const req = await freshClient('Normal');
  const q = (await quote(mechAToken, req.id, { price: 500, etaMinutes: 30 })).json();

  const res = await acceptQuote(req.token, req.id, q.id);
  assert.equal(res.statusCode, 200, res.body);
  const dto = res.json();
  assert.equal(dto.status, 'matched');
  assert.equal(dto.mechanicId, mechAId);
  assert.equal(dto.mechanicName, 'Alan Mech');
  assert.ok(dto.matchedAt);

  const event = events.find((e) => e.name === 'service_request.updated' && (e.data as { id: string }).id === req.id);
  assert.ok(event);
  assert.ok(event.audience?.userIds?.includes(req.clientId) && event.audience?.userIds?.includes(mechAId));
});

test('two quotes: accepting one closes the request to the other', async () => {
  const req = await freshClient('Normal');
  const qa = (await quote(mechAToken, req.id, { price: 500, etaMinutes: 30 })).json();
  const qb = (await quote(mechBToken, req.id, { price: 450, etaMinutes: 40 })).json();

  assert.equal((await acceptQuote(req.token, req.id, qa.id)).statusCode, 200);
  const second = await acceptQuote(req.token, req.id, qb.id);
  assert.equal(second.statusCode, 409);
});

test('two accepts racing on one request: exactly one wins', async () => {
  const req = await freshClient('Normal');
  const qa = (await quote(mechAToken, req.id, { price: 500, etaMinutes: 30 })).json();
  const qb = (await quote(mechBToken, req.id, { price: 450, etaMinutes: 40 })).json();

  const [a, b] = await Promise.all([acceptQuote(req.token, req.id, qa.id), acceptQuote(req.token, req.id, qb.id)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
});

test('only the owner accepts; withdrawn/rejected quotes cannot be accepted', async () => {
  const req = await freshClient('Normal');
  const q = (await quote(mechAToken, req.id, { price: 500, etaMinutes: 30 })).json();

  const other = await freshClient('Normal');
  assert.equal((await acceptQuote(other.token, req.id, q.id)).statusCode, 404);

  await ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${req.id}/quotes/withdraw`, headers: bearer(mechAToken) });
  assert.equal((await acceptQuote(req.token, req.id, q.id)).statusCode, 404);
});

test('a mechanic accepts an emergency first-come; a second is refused', async () => {
  const req = await freshClient('Emergency');
  const res = await acceptEmergency(mechAToken, req.id, { etaMinutes: 30 });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'matched');
  assert.equal(res.json().mechanicId, mechAId);

  const second = await acceptEmergency(mechBToken, req.id, { etaMinutes: 20 });
  assert.equal(second.statusCode, 409);
});

test('two mechanics racing on one emergency: exactly one wins', async () => {
  const req = await freshClient('Emergency');
  const [a, b] = await Promise.all([acceptEmergency(mechAToken, req.id, { etaMinutes: 30 }), acceptEmergency(mechBToken, req.id, { etaMinutes: 25 })]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
});

test('one active emergency per mechanic', async () => {
  // A fresh mechanic, so an emergency accepted in an earlier test does not leak in.
  const mech = await approveMechanic('solo@example.com', 'Solo');
  const first = await freshClient('Emergency');
  const second = await freshClient('Emergency');
  assert.equal((await acceptEmergency(mech.token, first.id, { etaMinutes: 30 })).statusCode, 200);
  const again = await acceptEmergency(mech.token, second.id, { etaMinutes: 30 });
  assert.equal(again.statusCode, 409);
});

test('emergency-accept rejects a non-emergency, an over-long ETA and an unapproved mechanic', async () => {
  const normal = await freshClient('Normal');
  assert.equal((await acceptEmergency(mechAToken, normal.id, { etaMinutes: 30 })).statusCode, 409);

  const emergency = await freshClient('Emergency');
  assert.equal((await acceptEmergency(mechAToken, emergency.id, { etaMinutes: 12 * 60 + 1 })).statusCode, 400);

  const unappr = (await signInAs(ctx.app, (await createUser(ctx.db, { email: 'u2@example.com', password: 'u2 password 1', role: 'mechanic' })).email, 'u2 password 1', 'mobile')).accessToken;
  assert.equal((await acceptEmergency(unappr, emergency.id, { etaMinutes: 30 })).statusCode, 403);
});
