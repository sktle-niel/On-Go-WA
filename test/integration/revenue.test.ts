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

async function report(payload: Record<string, unknown>, token = clientToken) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/payments', headers: bearer(token), payload });
}

test('the mobile surface reports payments; a retry books nothing twice', async () => {
  const first = await report({ requestId: 'req-1', platformFee: 50, paidAt: '2026-03-15T10:00:00Z', urgency: 'urgent' });
  assert.equal(first.statusCode, 204, first.body);
  const retry = await report({ requestId: 'req-1', platformFee: 50, paidAt: '2026-03-15T10:00:00Z', urgency: 'urgent' });
  assert.equal(retry.statusCode, 204);

  assert.equal((await report({ requestId: 'req-2', platformFee: 100, paidAt: '2026-03-20T02:00:00Z', urgency: 'emergency' })).statusCode, 204);
  assert.equal((await report({ requestId: 'req-3', platformFee: 0, paidAt: '2026-04-01T00:30:00Z' })).statusCode, 204);

  const rows = await ctx.db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM revenue_ledger');
  assert.equal(rows?.n, 3);
});

test('the console cannot report a payment', async () => {
  const res = await report({ requestId: 'req-9', platformFee: 50, paidAt: '2026-03-15T10:00:00Z' }, adminToken);
  assert.equal(res.statusCode, 403);
});

test('the summary is split by month and urgency, in the configured calendar', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/revenue/summary', headers: bearer(adminToken) });
  assert.equal(res.statusCode, 200, res.body);
  const summary = res.json();

  assert.equal(summary.priorityFeeRevenue, 150);
  assert.equal(summary.priorityFeeCount, 2);
  assert.equal(summary.months.length, 2);

  const [march, april] = summary.months;
  assert.equal(march.month, 'Mar');
  assert.equal(march.year, 2026);
  assert.equal(march.revenue, 150);
  assert.equal(march.transactions, 2);
  assert.deepEqual(march.byUrgency.urgent, { revenue: 50, transactions: 1 });
  assert.deepEqual(march.byUrgency.emergency, { revenue: 100, transactions: 1 });
  assert.deepEqual(march.byUrgency.normal, { revenue: 0, transactions: 0 });

  // 2026-04-01T00:30Z is already April 1 in Asia/Manila (UTC+8).
  assert.equal(april.month, 'Apr');
  assert.equal(april.revenue, 0);
  assert.equal(april.transactions, 1);
  assert.deepEqual(april.byUrgency.normal, { revenue: 0, transactions: 1 });
});

test('a client cannot read the summary', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/revenue/summary', headers: bearer(clientToken) });
  assert.equal(res.statusCode, 403);
});
