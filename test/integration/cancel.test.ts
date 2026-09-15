import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { PlatformEvent } from '../../src/events/bus.js';
import { expireOverdueJobs } from '../../src/services/jobs.service.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

interface Account {
  id: string;
  token: string;
}

interface Job {
  id: string;
  client: Account;
  mechanic: Account;
  quoteId: string;
}

let ctx: TestContext;
let adminToken: string;
let mech: Account;
let otherMech: Account;
const events: PlatformEvent[] = [];
let seq = 0;

const api = (method: 'GET' | 'POST', token: string, url: string, payload?: Record<string, unknown>) =>
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

/**
 * A fresh client's job, matched to a mechanic with the given ETA. An Emergency
 * gets its own new mechanic unless one is given, since a mechanic may hold
 * only one active emergency.
 */
async function matchedJob(
  urgency: 'Normal' | 'Urgent' | 'Emergency',
  options: { mechanic?: Account; etaMinutes?: number } = {},
): Promise<Job> {
  const mechanic = options.mechanic ?? (urgency === 'Emergency' ? await approvedMechanic('Emma') : mech);
  const client = await newClient();
  const booked = await api('POST', client.token, '/service-requests', { problem: 'Wont start', location: 'EDSA', urgency });
  assert.equal(booked.statusCode, 201, booked.body);
  const id = booked.json().id as string;

  let quoteId: string;
  if (urgency === 'Emergency') {
    const accepted = await api('POST', mechanic.token, `/service-requests/${id}/accept`, { etaMinutes: options.etaMinutes ?? 30 });
    assert.equal(accepted.statusCode, 200, accepted.body);
    quoteId = (await api('GET', mechanic.token, `/service-requests/${id}/quotes`)).json()[0].id;
  } else {
    const quote = await api('POST', mechanic.token, `/service-requests/${id}/quotes`, { price: 500, etaMinutes: options.etaMinutes ?? 30 });
    assert.equal(quote.statusCode, 201, quote.body);
    quoteId = quote.json().id;
    const accepted = await api('POST', client.token, `/service-requests/${id}/quotes/${quoteId}/accept`);
    assert.equal(accepted.statusCode, 200, accepted.body);
  }
  return { id, client, mechanic, quoteId };
}

const read = async (job: Job) => (await api('GET', job.client.token, `/service-requests/${job.id}`)).json();

/** As if the job had been matched `minutes` earlier: the ETA and the deadline move back with it. */
const matchedMinutesAgo = (id: string, minutes: number) =>
  ctx.db.query(
    `UPDATE service_requests
        SET accepted_at = accepted_at - make_interval(mins => $2::int),
            deadline_at = deadline_at - make_interval(mins => $2::int)
      WHERE id = $1`,
    [id, minutes],
  );

const pastDeadline = (id: string) =>
  ctx.db.query(`UPDATE service_requests SET deadline_at = now() - interval '1 minute' WHERE id = $1`, [id]);

const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin' });
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
  mech = await approvedMechanic('Mike');
  otherMech = await approvedMechanic('Otto');
  ctx.events.subscribe((event) => events.push(event));
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  events.length = 0;
});

test('accepting stamps the completion deadline for Urgent and Emergency, and none for Normal', async () => {
  const urgent = await read(await matchedJob('Urgent'));
  assert.equal(minutesBetween(urgent.matchedAt, urgent.deadlineAt), 3 * 24 * 60);
  assert.equal(minutesBetween(urgent.matchedAt, urgent.expectedArrivalAt), 30);

  const emergency = await read(await matchedJob('Emergency'));
  assert.equal(minutesBetween(emergency.matchedAt, emergency.deadlineAt), 12 * 60);

  const normal = await read(await matchedJob('Normal', { etaMinutes: 45 }));
  assert.equal(normal.deadlineAt, null);
  assert.equal(minutesBetween(normal.matchedAt, normal.expectedArrivalAt), 45);
});

test('while the mechanic is inside their ETA, the client can neither cancel nor reopen', async () => {
  const job = await matchedJob('Normal', { etaMinutes: 30 });

  const cancel = await api('POST', job.client.token, `/service-requests/${job.id}/cancel`, {});
  assert.equal(cancel.statusCode, 409);
  assert.ok(Date.parse(cancel.json().error.details.cancellableAt) > Date.now(), 'the refusal says when cancelling opens');

  assert.equal((await api('POST', job.client.token, `/service-requests/${job.id}/reopen`)).statusCode, 409);
  assert.equal((await read(job)).status, 'matched');
});

test('once the ETA passes, the client reopens: the mechanic is released, the quote stays live, and mechanics hear it', async () => {
  const job = await matchedJob('Urgent', { etaMinutes: 30 });
  assert.equal((await api('POST', mech.token, `/service-requests/${job.id}/navigating`)).statusCode, 200);
  await matchedMinutesAgo(job.id, 31);
  events.length = 0;

  const res = await api('POST', job.client.token, `/service-requests/${job.id}/reopen`);
  assert.equal(res.statusCode, 200, res.body);
  const dto = res.json();
  assert.equal(dto.status, 'pending');
  assert.equal(dto.mechanicId, null);
  assert.equal(dto.matchedAt, null);
  assert.equal(dto.deadlineAt, null);
  assert.equal(dto.navigating, false);
  assert.equal(dto.expiredAt, null);

  const quotes = (await api('GET', job.client.token, `/service-requests/${job.id}/quotes`)).json();
  assert.deepEqual(
    quotes.map((q: { id: string; accepted: boolean }) => [q.id, q.accepted]),
    [[job.quoteId, false]],
  );

  const event = events.find((e) => e.name === 'service_request.updated' && (e.data as { id: string }).id === job.id);
  assert.deepEqual(event?.audience?.roles, ['mechanic'], 'the job is in the open pool again');
  assert.ok((event?.audience?.userIds ?? []).includes(mech.id), 'the released mechanic is told');

  const requote = await api('POST', otherMech.token, `/service-requests/${job.id}/quotes`, { price: 450, etaMinutes: 20 });
  assert.equal(requote.statusCode, 201, requote.body);
});

test('arrival lifts the ETA lock, and started work ends the right to cancel', async () => {
  const arrived = await matchedJob('Normal', { etaMinutes: 120 });
  assert.equal((await api('POST', mech.token, `/service-requests/${arrived.id}/arrived`)).statusCode, 200);
  const cancelled = await api('POST', arrived.client.token, `/service-requests/${arrived.id}/cancel`, { reason: 'Changed my mind' });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().status, 'cancelled');
  assert.equal(cancelled.json().lastCancelReason, 'Changed my mind');
  assert.equal(cancelled.json().mechanicId, mech.id, 'a cancelled job keeps who it was matched to');

  const rebook = await api('POST', arrived.client.token, '/service-requests', { problem: 'Flat tire', location: 'EDSA', urgency: 'Normal' });
  assert.equal(rebook.statusCode, 201, 'the active slot is free again');

  const working = await matchedJob('Normal', { etaMinutes: 120 });
  await api('POST', mech.token, `/service-requests/${working.id}/arrived`);
  assert.equal((await api('POST', mech.token, `/service-requests/${working.id}/start-work`)).statusCode, 200);
  assert.equal((await api('POST', working.client.token, `/service-requests/${working.id}/cancel`, {})).statusCode, 409);
  assert.equal((await api('POST', working.client.token, `/service-requests/${working.id}/reopen`)).statusCode, 409);
});

test('the assigned mechanic cancels before setting off: the job returns to the pool with the reason, and their quote is withdrawn', async () => {
  const job = await matchedJob('Normal');

  const res = await api('POST', mech.token, `/service-requests/${job.id}/mechanic-cancel`, { reason: 'Car broke down' });
  assert.equal(res.statusCode, 200, res.body);
  const dto = res.json();
  assert.equal(dto.status, 'pending');
  assert.equal(dto.mechanicId, null);
  assert.equal(dto.lastCancelReason, 'Car broke down');
  assert.equal(dto.lastCancelledBy, 'Mike Mech');
  assert.ok(dto.lastCancelledAt);

  const offered = (await api('GET', job.client.token, `/service-requests/${job.id}/quotes`)).json();
  assert.equal(offered.length, 0, 'the client is not offered the same quote again');
  const own = (await api('GET', mech.token, `/service-requests/${job.id}/quotes`)).json();
  assert.ok(own[0].withdrawnAt, 'the mechanic sees their quote withdrawn');

  const requote = await api('POST', mech.token, `/service-requests/${job.id}/quotes`, { price: 600, etaMinutes: 40 });
  assert.equal(requote.statusCode, 201, 'and may quote afresh');
});

test('a mechanic cannot cancel an Emergency, a job under way, or a job that is not theirs', async () => {
  const emergency = await matchedJob('Emergency');
  const onEmergency = await api('POST', emergency.mechanic.token, `/service-requests/${emergency.id}/mechanic-cancel`, { reason: 'No' });
  assert.equal(onEmergency.statusCode, 409);

  const underway = await matchedJob('Normal');
  await api('POST', mech.token, `/service-requests/${underway.id}/navigating`);
  assert.equal((await api('POST', mech.token, `/service-requests/${underway.id}/mechanic-cancel`, { reason: 'No' })).statusCode, 409);

  const job = await matchedJob('Normal');
  const url = `/service-requests/${job.id}/mechanic-cancel`;
  assert.equal((await api('POST', otherMech.token, url, { reason: 'No' })).statusCode, 404);
  assert.equal((await api('POST', job.client.token, url, { reason: 'No' })).statusCode, 403);
  assert.equal((await api('POST', mech.token, url, {})).statusCode, 400, 'a reason is required');
  assert.equal((await api('POST', mech.token, url, { reason: '   ' })).statusCode, 400, 'a blank reason is not a reason');
  assert.equal((await read(job)).status, 'matched');
});

test('an Urgent job not under way by its deadline expires back to the pool on the next call', async () => {
  const job = await matchedJob('Urgent');
  await pastDeadline(job.id);
  events.length = 0;

  const dto = await read(job);
  assert.equal(dto.status, 'pending');
  assert.equal(dto.mechanicId, null);
  assert.ok(dto.expiredAt);
  assert.equal(dto.expiredByMechanic, 'Mike Mech');
  assert.equal(dto.lastCancelReason, 'Did not complete the job within the allowed time.');
  assert.ok(
    events.some((e) => e.name === 'service_request.updated' && (e.data as { id: string }).id === job.id),
    'the parties and the pool hear it',
  );

  const quotes = (await api('GET', job.client.token, `/service-requests/${job.id}/quotes`)).json();
  assert.equal(quotes.length, 1, 'the quote stays on the table');
  assert.equal((await api('POST', mech.token, `/service-requests/${job.id}/arrived`)).statusCode, 404, 'the released mechanic cannot act on it');

  const again = await api('POST', job.client.token, `/service-requests/${job.id}/quotes/${job.quoteId}/accept`);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().expiredAt, null, 'a fresh accept clears the stamps');
  assert.equal(again.json().lastCancelReason, null);
  assert.ok(again.json().deadlineAt, 'and starts a new clock');
});

test('an overdue Emergency expires once, its accept record is withdrawn, and its mechanic may take another', async () => {
  const job = await matchedJob('Emergency');
  await pastDeadline(job.id);

  assert.equal(await expireOverdueJobs(ctx.db, ctx.events), 1);
  assert.equal(await expireOverdueJobs(ctx.db, ctx.events), 0, 'a job expires once');

  const offered = (await api('GET', job.client.token, `/service-requests/${job.id}/quotes`)).json();
  assert.equal(offered.length, 0, 'the accept record is not offered as a quote');
  const accept = await api('POST', job.client.token, `/service-requests/${job.id}/quotes/${job.quoteId}/accept`);
  assert.equal(accept.statusCode, 409, 'nor can the client accept an Emergency');

  const next = await matchedJob('Emergency', { mechanic: job.mechanic });
  assert.equal((await read(next)).mechanicId, job.mechanic.id);
});

test('started work stops the clock, and a Normal job has no deadline to miss', async () => {
  const working = await matchedJob('Urgent');
  await api('POST', mech.token, `/service-requests/${working.id}/arrived`);
  assert.equal((await api('POST', mech.token, `/service-requests/${working.id}/start-work`)).statusCode, 200);
  await pastDeadline(working.id);

  const normal = await matchedJob('Normal');
  await matchedMinutesAgo(normal.id, 30 * 24 * 60);

  await expireOverdueJobs(ctx.db, ctx.events);
  assert.equal((await read(working)).status, 'matched');
  assert.equal((await read(normal)).status, 'matched');
});
