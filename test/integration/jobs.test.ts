import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { PlatformEvent } from '../../src/events/bus.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let clientToken: string;
let clientId: string;
let otherClientToken: string;
let mechanicToken: string;
let adminToken: string;

const events: PlatformEvent[] = [];

before(async () => {
  ctx = await createTestApp();
  const client = await createUser(ctx.db, { email: 'client@example.com', password: 'client password 1', role: 'client', firstName: 'Cita', lastName: 'Client' });
  clientId = client.id;
  await createUser(ctx.db, { email: 'other@example.com', password: 'other password 1', role: 'client' });
  await createUser(ctx.db, { email: 'mech@example.com', password: 'mech password 1', role: 'mechanic' });
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin' });

  clientToken = (await signInAs(ctx.app, 'client@example.com', 'client password 1', 'mobile')).accessToken;
  otherClientToken = (await signInAs(ctx.app, 'other@example.com', 'other password 1', 'mobile')).accessToken;
  mechanicToken = (await signInAs(ctx.app, 'mech@example.com', 'mech password 1', 'mobile')).accessToken;
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;

  ctx.events.subscribe((e) => events.push(e));
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  events.length = 0;
});

const book = (token: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/service-requests', headers: bearer(token), payload: body });

const NORMAL = { problem: 'Flat tire', location: 'EDSA cor. Ayala', urgency: 'Normal' };

test('a client books a request and the priority fee follows the urgency', async () => {
  const res = await book(clientToken, { problem: 'Dead battery', description: 'Wont start', location: 'BGC', urgency: 'Emergency', latitude: 14.55, longitude: 121.05 });
  assert.equal(res.statusCode, 201, res.body);
  const dto = res.json();
  assert.equal(dto.status, 'pending');
  assert.equal(dto.urgency, 'Emergency');
  assert.equal(dto.surcharge, 100);
  assert.equal(dto.problem, 'Dead battery');
  assert.equal(dto.location, 'BGC');
  assert.equal(dto.clientName, 'Cita Client');
  assert.equal(dto.latitude, 14.55);
  assert.equal(dto.mechanicId, null);

  const event = events.find((e) => e.name === 'service_request.created' && (e.data as { id: string }).id === dto.id);
  assert.ok(event, 'service_request.created published');
  assert.deepEqual(event.audience?.roles, ['mechanic']);
});

test('a client may hold only one active request', async () => {
  const second = await book(clientToken, NORMAL);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, 'conflict');
});

test('two rapid bookings from one client still yield only one active request', async () => {
  const fresh = (await signInAs(ctx.app, (await createUser(ctx.db, { email: 'race@example.com', password: 'race password 1', role: 'client' })).email, 'race password 1', 'mobile')).accessToken;
  const [a, b] = await Promise.all([book(fresh, NORMAL), book(fresh, { ...NORMAL, urgency: 'Urgent' })]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [201, 409], 'exactly one booking wins');
});

test('only clients can book; mechanics browse the open pool', async () => {
  assert.equal((await book(mechanicToken, NORMAL)).statusCode, 403);

  const open = await ctx.app.inject({ method: 'GET', url: '/api/v1/service-requests?scope=open', headers: bearer(mechanicToken) });
  assert.equal(open.statusCode, 200);
  assert.ok(open.json().every((r: { status: string }) => r.status === 'pending'));
  assert.ok(open.json().length >= 1);

  const mine = await ctx.app.inject({ method: 'GET', url: '/api/v1/service-requests?scope=mine', headers: bearer(clientToken) });
  assert.ok(mine.json().every((r: { clientId: string }) => r.clientId === clientId));
});

test('ownership on reading one request', async () => {
  const id = (await ctx.app.inject({ method: 'GET', url: '/api/v1/service-requests?scope=mine', headers: bearer(clientToken) })).json()[0].id;

  assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/v1/service-requests/${id}`, headers: bearer(clientToken) })).statusCode, 200);
  assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/v1/service-requests/${id}`, headers: bearer(adminToken) })).statusCode, 200);
  assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/v1/service-requests/${id}`, headers: bearer(mechanicToken) })).statusCode, 200); // pending → open to mechanics
  assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/v1/service-requests/${id}`, headers: bearer(otherClientToken) })).statusCode, 404);
});

test('a client cancels their pending request and can then book again', async () => {
  const mine = (await ctx.app.inject({ method: 'GET', url: '/api/v1/service-requests?scope=mine', headers: bearer(clientToken) })).json();
  const id = mine.find((r: { status: string }) => r.status === 'pending').id;

  const cancel = await ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${id}/cancel`, headers: bearer(clientToken), payload: { reason: 'found help elsewhere' } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().status, 'cancelled');
  assert.equal(cancel.json().lastCancelledBy, 'Cita Client');
  assert.equal(cancel.json().lastCancelReason, 'found help elsewhere');

  // Cancelling again is a conflict (already cancelled).
  const again = await ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${id}/cancel`, headers: bearer(clientToken), payload: {} });
  assert.equal(again.statusCode, 409);

  // The active slot is free, so a new booking succeeds.
  const rebook = await book(clientToken, NORMAL);
  assert.equal(rebook.statusCode, 201, rebook.body);

  // A stranger cannot cancel someone else's request.
  const strangerCancel = await ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${rebook.json().id}/cancel`, headers: bearer(otherClientToken), payload: {} });
  assert.equal(strangerCancel.statusCode, 404);
});
