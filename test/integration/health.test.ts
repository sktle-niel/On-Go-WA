import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createTestApp, type TestContext } from '../helpers/app.js';

let ctx: TestContext;

before(async () => {
  ctx = await createTestApp();
});

after(async () => {
  await ctx.close();
});

test('liveness and readiness answer', async () => {
  const live = await ctx.app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { status: 'ok' });

  const ready = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: 'ok', database: 'up' });
});

test('security headers are present and CORS reflects a dev origin', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/health/live',
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
});

test('unknown routes use the error envelope', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.error.code, 'not_found');
  assert.ok(body.error.requestId);
});

test('the OpenAPI document lists the contract routes', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
  assert.equal(res.statusCode, 200);
  const paths = Object.keys(res.json().paths as Record<string, unknown>);
  for (const expected of [
    '/api/v1/auth/sign-in',
    '/api/v1/auth/sign-out',
    '/api/v1/auth/password',
    '/api/v1/auth/password/reset',
    '/api/v1/verification-requests',
    '/api/v1/verification-requests/{id}',
    '/api/v1/verification-requests/{id}/decision',
    '/api/v1/moderation/activity',
    '/api/v1/moderators',
    '/api/v1/moderators/{id}',
    '/api/v1/moderators/{id}/permissions',
    '/api/v1/moderators/{id}/profile',
    '/api/v1/audit-log',
    '/api/v1/payments',
    '/api/v1/revenue/summary',
    '/api/v1/platform/appearance',
    '/api/v1/platform/points-policy',
  ]) {
    assert.ok(paths.includes(expected), `missing ${expected} in OpenAPI paths`);
  }
});
