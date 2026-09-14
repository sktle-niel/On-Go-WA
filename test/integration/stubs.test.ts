import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
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

test('the appearance write side is still 501, behind its guards', async () => {
  const anonymous = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/platform/appearance' });
  assert.equal(anonymous.statusCode, 401);

  const wrongRole = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/platform/appearance', headers: bearer(clientToken) });
  assert.equal(wrongRole.statusCode, 403);

  const stub = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/platform/appearance', headers: bearer(adminToken) });
  assert.equal(stub.statusCode, 501);
  assert.equal(stub.json().error.code, 'not_implemented');
});

test('the appearance is public and empty until published', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/platform/appearance' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { authBackgroundUrl: null, updatedAt: null });
});

test('request bodies are validated before the handler runs', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/moderators',
    headers: bearer(adminToken),
    payload: { name: 'Mo', email: 'not-an-email', temporaryPassword: 'short' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'validation_failed');
});
