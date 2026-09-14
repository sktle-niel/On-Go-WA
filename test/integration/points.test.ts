import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PlatformEvent } from '../../src/events/bus.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let adminToken: string;
let clientToken: string;

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 123', role: 'admin' });
  await createUser(ctx.db, { email: 'client@example.com', password: 'client password 1', role: 'client' });
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 123', 'console')).accessToken;
  clientToken = (await signInAs(ctx.app, 'client@example.com', 'client password 1', 'mobile')).accessToken;
});

after(async () => {
  await ctx.close();
});

test('the policy is public and starts at the Dart defaults', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/platform/points-policy' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { clientNormal: 1, clientUrgent: 3, clientEmergency: 5, mechanicPerPeso: 0.05 });
});

test('only an admin may change it', async () => {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/platform/points-policy',
    headers: bearer(clientToken),
    payload: { clientNormal: 2, clientUrgent: 4, clientEmergency: 6, mechanicPerPeso: 0.1 },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'forbidden');

  const denied = await ctx.db.queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM security_events WHERE event = 'authz.denied'`,
  );
  assert.equal(denied?.n, 1);
});

test('an admin update is stored, returned, and published as an event', async () => {
  const received: PlatformEvent[] = [];
  const unsubscribe = ctx.events.subscribe((event) => received.push(event));

  const res = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/platform/points-policy',
    headers: bearer(adminToken),
    payload: { clientNormal: 2, clientUrgent: 4.5, clientEmergency: 6, mechanicPerPeso: 0.1 },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { clientNormal: 2, clientUrgent: 4.5, clientEmergency: 6, mechanicPerPeso: 0.1 });

  const read = await ctx.app.inject({ method: 'GET', url: '/api/v1/platform/points-policy' });
  assert.deepEqual(read.json(), { clientNormal: 2, clientUrgent: 4.5, clientEmergency: 6, mechanicPerPeso: 0.1 });

  unsubscribe();
  assert.equal(received.length, 1);
  assert.equal(received[0]?.name, 'points_policy.updated');
});

test('negative rates are rejected by the schema', async () => {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/platform/points-policy',
    headers: bearer(adminToken),
    payload: { clientNormal: -1, clientUrgent: 4, clientEmergency: 6, mechanicPerPeso: 0.1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'validation_failed');
});
