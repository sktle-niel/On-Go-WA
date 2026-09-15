import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { authenticateAccessToken } from '../../src/auth/guard.js';
import { reportCompletedPayment } from '../../src/services/revenue.service.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let adminToken: string;
let clientToken: string;
let mechanicToken: string;
let strangerToken: string;
let clientId: string;
let mechanicId: string;
let paidRequestId: string;
let unpaidRequestId: string;

/**
 * A settled job written straight to the tables, so its payment time is chosen
 * by the test: calendar bucketing is what the summary test checks. The pay
 * flow itself is covered in payments.test.ts.
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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const summary = () => ctx.app.inject({ method: 'GET', url: '/api/v1/revenue/summary', headers: bearer(adminToken) });

const report = (token: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/payments', headers: bearer(token), payload });

const ledgerRows = async (ref: string) =>
  (await ctx.db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM revenue_ledger WHERE request_ref = $1', [ref]))?.n;

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

  // A job the server holds that is matched but not paid yet.
  const unpaid = await ctx.db.queryOne<{ id: string }>(
    `INSERT INTO service_requests (client_id, mechanic_id, status, urgency, issue)
     VALUES ($1, $2, 'matched'::request_status, 'Normal'::urgency_level, 'Wont start')
     RETURNING id`,
    [clientId, mechanicId],
  );
  unpaidRequestId = unpaid?.id ?? '';
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

test('reporting a job the server holds books nothing: only a paid job the caller took part in is acknowledged', async () => {
  const snapshot = (await summary()).json();
  const invented = { platformFee: 99999, paidAt: minutesAgo(1), urgency: 'emergency' };

  assert.equal((await report(strangerToken, { requestId: paidRequestId, ...invented })).statusCode, 404, 'not their job');
  assert.equal(
    (await report(clientToken, { requestId: unpaidRequestId, platformFee: 0, paidAt: minutesAgo(1) })).statusCode,
    404,
    'a server job is paid through /pay, not reported',
  );
  assert.equal((await report(clientToken, { requestId: paidRequestId, ...invented })).statusCode, 204, 'the client of a paid job');
  assert.equal((await report(mechanicToken, { requestId: paidRequestId, ...invented })).statusCode, 204, 'the mechanic of a paid job');

  assert.deepEqual((await summary()).json(), snapshot, 'an invented fee moves no figure');
  assert.equal(await ledgerRows(paidRequestId), 0);
});

test('a device that settles jobs itself still books its payments: once, with the priority fee its urgency carries', async () => {
  const start = (await summary()).json();
  const legacy = { requestId: '1726380000000', platformFee: 50, paidAt: minutesAgo(2), urgency: 'urgent' };

  assert.equal((await report(clientToken, legacy)).statusCode, 204);
  assert.equal((await report(clientToken, legacy)).statusCode, 204, 'a retry is fine');
  assert.equal(await ledgerRows(legacy.requestId), 1, 'and books nothing twice');
  const booked = (await summary()).json();
  assert.equal(booked.priorityFeeRevenue - start.priorityFeeRevenue, 50);
  assert.equal(booked.priorityFeeCount - start.priorityFeeCount, 1);

  const denied = async () =>
    (await ctx.db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM security_events WHERE event = 'api.validation_rejected'`))?.n ?? 0;
  const deniedBefore = await denied();

  assert.equal((await report(clientToken, { ...legacy, requestId: 'r-2', platformFee: 99999 })).statusCode, 400, 'an invented fee');
  assert.equal((await report(clientToken, { ...legacy, requestId: 'r-3', platformFee: 100 })).statusCode, 400, 'an Urgent fee is 50');
  assert.equal((await denied()) - deniedBefore, 2, 'each wrong fee is logged');
  assert.equal((await report(mechanicToken, { ...legacy, requestId: 'r-4' })).statusCode, 403, 'the client reports, not the mechanic');
  assert.equal((await report(clientToken, { ...legacy, requestId: 'r-5', paidAt: minutesAgo(-60) })).statusCode, 400, 'from the future');
  assert.equal((await report(clientToken, { ...legacy, requestId: 'r-6', paidAt: minutesAgo(8 * 24 * 60) })).statusCode, 400, 'too old');
  for (const ref of ['r-2', 'r-3', 'r-4', 'r-5', 'r-6']) assert.equal(await ledgerRows(ref), 0, `${ref} booked nothing`);

  assert.equal((await report(clientToken, { requestId: 'r-7', platformFee: 0, paidAt: minutesAgo(1) })).statusCode, 204, 'a Normal job carries no fee');
});

test('one client books at most 20 device reports a day', async () => {
  await createUser(ctx.db, { email: 'busy@example.com', password: 'busy client pass', role: 'client' });
  const token = (await signInAs(ctx.app, 'busy@example.com', 'busy client pass', 'mobile')).accessToken;
  const normal = (ref: string) => report(token, { requestId: ref, platformFee: 0, paidAt: minutesAgo(1) });

  for (let i = 0; i < 20; i += 1) {
    assert.equal((await normal(`cap-${i}`)).statusCode, 204, `report ${i}`);
  }
  const over = await normal('cap-20');
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().error.code, 'rate_limited');
  assert.equal((await normal('cap-3')).statusCode, 204, 'a retry of a booked report is still fine');
});

test('with the compatibility window closed, a job the server does not hold is simply not found', async () => {
  const auth = await authenticateAccessToken(ctx.db, clientToken);
  await assert.rejects(
    reportCompletedPayment(
      ctx.db,
      auth,
      { requestId: 'closed-1', platformFee: 0, paidAt: minutesAgo(1) },
      { legacyReports: false, meta: { ipHash: Buffer.alloc(32), requestId: 'test' } },
    ),
    (error: { code?: string }) => error.code === 'not_found',
  );
  assert.equal(await ledgerRows('closed-1'), 0);
});

test('the console cannot report a payment', async () => {
  const res = await report(adminToken, { requestId: paidRequestId, platformFee: 50, paidAt: minutesAgo(1) });
  assert.equal(res.statusCode, 403);
});

test('a client cannot read the summary', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/revenue/summary', headers: bearer(clientToken) });
  assert.equal(res.statusCode, 403);
});
