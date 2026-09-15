import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { PlatformEvent } from '../../src/events/bus.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

interface Account {
  id: string;
  token: string;
}

let ctx: TestContext;
let adminToken: string;
let mech: Account;
const events: PlatformEvent[] = [];
let seq = 0;

const api = (method: 'GET' | 'POST' | 'PUT', token: string, url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: bearer(token), ...(payload === undefined ? {} : { payload }) });

async function approvedMechanic(name: string): Promise<Account> {
  seq += 1;
  const email = `mech${seq}@example.com`;
  const user = await createUser(ctx.db, { email, password: 'a mech password', role: 'mechanic', firstName: name, lastName: 'Mech' });
  const token = (await signInAs(ctx.app, email, 'a mech password', 'mobile')).accessToken;
  const filed = await api('POST', token, '/verification-requests', { name, email, role: 'mechanic' });
  await api('POST', adminToken, `/verification-requests/${filed.json().id}/decision`, { action: 'approved' });
  return { id: user.id, token };
}

async function newClient(): Promise<Account> {
  seq += 1;
  const email = `client${seq}@example.com`;
  const user = await createUser(ctx.db, { email, password: 'a client password', role: 'client' });
  return { id: user.id, token: (await signInAs(ctx.app, email, 'a client password', 'mobile')).accessToken };
}

/** Books a job for `client`, matches it to a mechanic, and (unless told not to) works it to service complete. */
async function finishedJob(
  client: Account,
  urgency: 'Normal' | 'Urgent' | 'Emergency',
  options: { price?: number; mechanic?: Account; complete?: boolean } = {},
): Promise<string> {
  const mechanic = options.mechanic ?? mech;
  const booked = await api('POST', client.token, '/service-requests', { problem: 'Wont start', location: 'EDSA', urgency });
  assert.equal(booked.statusCode, 201, booked.body);
  const id = booked.json().id as string;

  if (urgency === 'Emergency') {
    const accepted = await api('POST', mechanic.token, `/service-requests/${id}/accept`, { etaMinutes: 30 });
    assert.equal(accepted.statusCode, 200, accepted.body);
  } else {
    const quote = await api('POST', mechanic.token, `/service-requests/${id}/quotes`, { price: options.price ?? 500, etaMinutes: 30 });
    assert.equal(quote.statusCode, 201, quote.body);
    const accepted = await api('POST', client.token, `/service-requests/${id}/quotes/${quote.json().id}/accept`);
    assert.equal(accepted.statusCode, 200, accepted.body);
  }

  if (options.complete !== false) {
    for (const step of ['arrived', 'start-work', 'complete-service']) {
      const res = await api('POST', mechanic.token, `/service-requests/${id}/${step}`);
      assert.equal(res.statusCode, 200, res.body);
    }
  }
  return id;
}

const pay = (client: Account, id: string, body: Record<string, unknown> = {}) =>
  api('POST', client.token, `/service-requests/${id}/pay`, body);

const wallet = async (account: Account) => (await api('GET', account.token, '/points/wallet')).json();

const paymentRows = async (id: string) =>
  (await ctx.db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE request_id = $1`, [id]))?.n;

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin' });
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
  mech = await approvedMechanic('Mike');
  ctx.events.subscribe((event) => events.push(event));
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  events.length = 0;
});

test('paying a finished Normal job closes it, settles the figures on the server, and awards points', async () => {
  const client = await newClient();
  const id = await finishedJob(client, 'Normal', { price: 500 });

  // Figures in the body are not the client's to set; the schema drops them.
  const res = await pay(client, id, { amount: 1, platformFee: 99999 });
  assert.equal(res.statusCode, 200, res.body);
  const dto = res.json();
  assert.equal(dto.status, 'completed');
  assert.equal(dto.paymentCompleted, true);
  assert.ok(dto.paymentCompletedAt);
  assert.equal(dto.amountPaid, 500, 'the quote price, not a figure from the body');
  assert.equal(dto.platformFeeCharged, 0);
  assert.equal(dto.feePaidWithPoints, null);
  assert.equal(dto.pointsAwarded, 25, '500 pesos at 0.05 points per peso');
  assert.equal(dto.clientPointsAwarded, 1);
  assert.equal(await paymentRows(id), 1);

  const updated = events.find((e) => e.name === 'service_request.updated' && (e.data as { id: string }).id === id);
  const parties = updated?.audience?.userIds ?? [];
  assert.ok(parties.includes(client.id) && parties.includes(mech.id), 'both parties hear the job closed');
  const booked = events.find((e) => e.name === 'payment.completed');
  assert.deepEqual(booked?.audience?.roles, ['admin']);

  const clientWallet = await wallet(client);
  assert.equal(clientWallet.balance, 1);
  assert.equal(clientWallet.entries[0].kind, 'clientJobCompleted');

  // The job is closed, so the client's one active slot is free again.
  const again = await api('POST', client.token, '/service-requests', { problem: 'Flat tire', location: 'EDSA', urgency: 'Normal' });
  assert.equal(again.statusCode, 201, again.body);
});

test('a job is paid once, even when two pays race', async () => {
  const client = await newClient();
  const id = await finishedJob(client, 'Normal', { price: 300 });

  const [a, b] = await Promise.all([pay(client, id), pay(client, id)]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(await paymentRows(id), 1);

  const again = await pay(client, id);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().amountPaid, 300);

  const entries = await ctx.db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM points_ledger WHERE request_id = $1`, [id]);
  assert.equal(entries?.n, 2, 'one credit for the client, one for the mechanic');
  assert.equal((await wallet(client)).balance, 1);
});

test('pay is refused before the service is complete, to another client, and to the mechanic', async () => {
  const client = await newClient();
  const id = await finishedJob(client, 'Normal', { complete: false });

  const early = await pay(client, id);
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().error.code, 'conflict');

  const stranger = await newClient();
  assert.equal((await pay(stranger, id)).statusCode, 404);
  assert.equal((await api('POST', mech.token, `/service-requests/${id}/pay`, {})).statusCode, 403);
  assert.equal(await paymentRows(id), 0);
});

test('an Emergency is paid the amount its mechanic set, plus the priority fee', async () => {
  const client = await newClient();
  const id = await finishedJob(client, 'Emergency');

  assert.equal((await pay(client, id)).statusCode, 409, 'no agreed amount yet');

  const other = await approvedMechanic('Otto');
  assert.equal((await api('PUT', other.token, `/service-requests/${id}/agreed-amount`, { amount: 1200 })).statusCode, 404);
  assert.equal((await api('PUT', client.token, `/service-requests/${id}/agreed-amount`, { amount: 1200 })).statusCode, 403);

  const set = await api('PUT', mech.token, `/service-requests/${id}/agreed-amount`, { amount: 1200 });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().agreedPaymentAmount, 1200);
  assert.ok(set.json().agreedPaymentAmountSetAt);

  const stale = await pay(client, id, { expectedAmount: 1000 });
  assert.equal(stale.statusCode, 409, 'the client saw a different amount');

  const res = await pay(client, id, { expectedAmount: 1200 });
  assert.equal(res.statusCode, 200, res.body);
  const dto = res.json();
  assert.equal(dto.amountPaid, 1200);
  assert.equal(dto.platformFeeCharged, 100);
  assert.equal(dto.pointsAwarded, 60);
  assert.equal(dto.clientPointsAwarded, 5);

  const late = await api('PUT', mech.token, `/service-requests/${id}/agreed-amount`, { amount: 1500 });
  assert.equal(late.statusCode, 409, 'a paid job cannot be repriced');
});

test('only an Emergency takes an agreed amount', async () => {
  const client = await newClient();
  const id = await finishedJob(client, 'Urgent', { price: 800 });
  const res = await api('PUT', mech.token, `/service-requests/${id}/agreed-amount`, { amount: 900 });
  assert.equal(res.statusCode, 409);
});

test('a mechanic converts points to balance, and the wallet adds up', async () => {
  const mechanic = await approvedMechanic('Wally');
  const client = await newClient();
  assert.equal((await pay(client, await finishedJob(client, 'Normal', { price: 1000, mechanic }))).statusCode, 200);

  const start = await wallet(mechanic);
  assert.deepEqual(
    { balance: start.balance, earnings: start.earnings, convertedPesos: start.convertedPesos, availableBalance: start.availableBalance },
    { balance: 50, earnings: 1000, convertedPesos: 0, availableBalance: 1000 },
  );

  const converted = await api('POST', mechanic.token, '/points/convert', { points: 20 });
  assert.equal(converted.statusCode, 200, converted.body);
  const now = converted.json();
  assert.equal(now.balance, 30);
  assert.equal(now.convertedPesos, 20);
  assert.equal(now.availableBalance, 1020);
  assert.equal(now.entries[0].kind, 'mechanicConvertedToBalance');
  assert.equal(now.entries[0].points, -20);
  assert.equal(now.entries[0].pesos, 20);

  assert.equal((await api('POST', mechanic.token, '/points/convert', { points: 31 })).statusCode, 409, 'more than the balance');
  assert.equal((await api('POST', mechanic.token, '/points/convert', { points: 0.5 })).statusCode, 400, 'under the minimum');
  assert.equal((await api('POST', client.token, '/points/convert', { points: 1 })).statusCode, 403);
  assert.equal((await api('GET', adminToken, '/points/wallet')).statusCode, 403);
});

test('the priority fee can be paid with points; a short balance is charged in pesos instead', async () => {
  // A generous Normal rate, so one job earns enough points to cover a fee.
  const policy = (clientNormal: number) =>
    api('PUT', adminToken, '/platform/points-policy', { clientNormal, clientUrgent: 3, clientEmergency: 5, mechanicPerPeso: 0.05 });
  assert.equal((await policy(60)).statusCode, 200);
  try {
    const client = await newClient();
    assert.equal((await pay(client, await finishedJob(client, 'Normal'))).statusCode, 200);
    assert.equal((await wallet(client)).balance, 60);

    const covered = await pay(client, await finishedJob(client, 'Urgent', { price: 800 }), { payFeeWithPoints: true });
    assert.equal(covered.statusCode, 200, covered.body);
    assert.equal(covered.json().platformFeeCharged, 50);
    assert.equal(covered.json().feePaidWithPoints, 50);
    const afterCovered = await wallet(client);
    assert.equal(afterCovered.balance, 13, '60, less 50 for the fee, plus 3 for the Urgent job');
    assert.ok(
      afterCovered.entries.some(
        (e: { kind: string; points: number; pesos: number | null }) => e.kind === 'clientPaidSurcharge' && e.points === -50 && e.pesos === 50,
      ),
    );

    const short = await pay(client, await finishedJob(client, 'Urgent', { price: 800 }), { payFeeWithPoints: true });
    assert.equal(short.statusCode, 200, short.body);
    assert.equal(short.json().platformFeeCharged, 50, 'the fee is still charged');
    assert.equal(short.json().feePaidWithPoints, null, 'in pesos, because 13 points do not cover it');
    assert.equal((await wallet(client)).balance, 16);
  } finally {
    await policy(1);
  }
});
