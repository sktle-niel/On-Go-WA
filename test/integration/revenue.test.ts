import '../helpers/env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let adminToken: string;
let clientToken: string;
let mechanicToken: string;
let strangerToken: string;
let clientId: string;
let mechanicId: string;
let paidRequestId: string;

/**
 * A settled job written straight to the tables, so its payment time is chosen
 * by the test: calendar bucketing is what this file checks. The pay flow
 * itself is covered in payments.test.ts.
 */
async function settledJob(
  urgency: 'Normal' | 'Urgent' | 'Emergency',
  fee: number,
  at: string,
  status: 'completed' | 'failed' = 'completed',
): Promise<string> {
  const request = await ctx.db.queryOne<{ id: string }>(
    `INSERT INTO service_requests (client_id, mechanic_id, status, urgency, issue, surcharge, completed_at)
     VALUES ($1, $2, $3::request_status, $4::urgency_level, 'Flat tire', $5, $6::timestamptz)
     RETURNING id`,
    [clientId, mechanicId, status === 'completed' ? 'completed' : 'cancelled', urgency, fee, at],
  );
  if (!request) throw new Error('seed request was not written');
  await ctx.db.query(
    `INSERT INTO payments (request_id, client_id, mechanic_id, amount, platform_fee, status, idempotency_key, completed_at)
     VALUES ($1, $2, $3, 500, $4::numeric, $5::payment_status, $6, $7::timestamptz)`,
    [request.id, clientId, mechanicId, fee, status, `seed-${request.id}`, at],
  );
  return request.id;
}

const summary = () => ctx.app.inject({ method: 'GET', url: '/api/v1/revenue/summary', headers: bearer(adminToken) });

const report = (token: string, requestId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/payments',
    headers: bearer(token),
    payload: { requestId, platformFee: 99999, paidAt: '2026-03-15T10:00:00Z', urgency: 'emergency' },
  });

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 123', role: 'admin' });
  clientId = (await createUser(ctx.db, { email: 'client@example.com', password: 'client password 1', role: 'client' })).id;
  mechanicId = (await createUser(ctx.db, { email: 'mech@example.com', password: 'mech password 1', role: 'mechanic' })).id;
  await createUser(ctx.db, { email: 'stranger@example.com', password: 'stranger password 1', role: 'client' });
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 123', 'console')).accessToken;
  clientToken = (await signInAs(ctx.app, 'client@example.com', 'client password 1', 'mobile')).accessToken;
  mechanicToken = (await signInAs(ctx.app, 'mech@example.com', 'mech password 1', 'mobile')).accessToken;
  strangerToken = (await signInAs(ctx.app, 'stranger@example.com', 'stranger password 1', 'mobile')).accessToken;

  paidRequestId = await settledJob('Urgent', 50, '2026-03-15T10:00:00Z');
  await settledJob('Emergency', 100, '2026-03-20T02:00:00Z');
  await settledJob('Normal', 0, '2026-04-01T00:30:00Z');
  // A payment that did not complete is not revenue.
  await settledJob('Urgent', 50, '2026-03-16T10:00:00Z', 'failed');
});

after(async () => {
  await ctx.close();
});

test('the summary reads completed payments, split by month and urgency, in the configured calendar', async () => {
  const res = await summary();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();

  assert.equal(body.priorityFeeRevenue, 150);
  assert.equal(body.priorityFeeCount, 2);
  assert.equal(body.months.length, 2);

  const [march, april] = body.months;
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

test('a phone report books nothing: only a paid job the caller took part in is acknowledged', async () => {
  const snapshot = (await summary()).json();

  assert.equal((await report(clientToken, 'req-1')).statusCode, 404, 'not a job id');
  assert.equal((await report(clientToken, randomUUID())).statusCode, 404, 'no such job');
  assert.equal((await report(strangerToken, paidRequestId)).statusCode, 404, 'not their job');
  assert.equal((await report(clientToken, paidRequestId)).statusCode, 204, 'the client of a paid job');
  assert.equal((await report(mechanicToken, paidRequestId)).statusCode, 204, 'the mechanic of a paid job');

  assert.deepEqual((await summary()).json(), snapshot, 'an invented fee moves no figure');
  const legacy = await ctx.db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM revenue_ledger');
  assert.equal(legacy?.n, 0, 'the retired ledger is never written');
});

test('the console cannot report a payment', async () => {
  const res = await report(adminToken, paidRequestId);
  assert.equal(res.statusCode, 403);
});

test('a client cannot read the summary', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/revenue/summary', headers: bearer(clientToken) });
  assert.equal(res.statusCode, 403);
});
