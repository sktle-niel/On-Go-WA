import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let adminToken: string;
let mechAToken: string;
let mechBToken: string;
let clientTokenForRole: string;

let seq = 0;

async function approveMechanic(email: string, name: string): Promise<string> {
  await createUser(ctx.db, { email, password: 'a mech password', role: 'mechanic', firstName: name, lastName: 'Mech' });
  const token = (await signInAs(ctx.app, email, 'a mech password', 'mobile')).accessToken;
  const vr = await ctx.app.inject({ method: 'POST', url: '/api/v1/verification-requests', headers: bearer(token), payload: { name, email, role: 'mechanic' } });
  await ctx.app.inject({ method: 'POST', url: `/api/v1/verification-requests/${vr.json().id}/decision`, headers: bearer(adminToken), payload: { action: 'approved' } });
  return token;
}

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin' });
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
  mechAToken = await approveMechanic('mecha@example.com', 'Alan');
  mechBToken = await approveMechanic('mechb@example.com', 'Bern');
  await createUser(ctx.db, { email: 'roleclient@example.com', password: 'role client 1', role: 'client' });
  clientTokenForRole = (await signInAs(ctx.app, 'roleclient@example.com', 'role client 1', 'mobile')).accessToken;
});

after(async () => {
  await ctx.close();
});

/** A Normal job matched to mechA, ready to advance. */
async function matchedJob(): Promise<{ id: string; clientToken: string }> {
  seq += 1;
  const email = `client${seq}@example.com`;
  await createUser(ctx.db, { email, password: 'a client password', role: 'client' });
  const clientToken = (await signInAs(ctx.app, email, 'a client password', 'mobile')).accessToken;
  const req = (await ctx.app.inject({ method: 'POST', url: '/api/v1/service-requests', headers: bearer(clientToken), payload: { problem: 'Wont start', location: 'EDSA', urgency: 'Normal' } })).json();
  const q = (await ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${req.id}/quotes`, headers: bearer(mechAToken), payload: { price: 500, etaMinutes: 30 } })).json();
  await ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${req.id}/quotes/${q.id}/accept`, headers: bearer(clientToken) });
  return { id: req.id, clientToken };
}

const step = (token: string, id: string, path: string) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/service-requests/${id}/${path}`, headers: bearer(token) });

test('a job advances through the whole status machine', async () => {
  const job = await matchedJob();

  assert.equal((await step(mechAToken, job.id, 'navigating')).json().navigating, true);
  assert.equal((await step(mechAToken, job.id, 'en-route')).json().enRoute, true);
  const arrived = await step(mechAToken, job.id, 'arrived');
  assert.equal(arrived.json().arrived, true);
  assert.equal((await step(mechAToken, job.id, 'start-work')).json().workStarted, true);
  const done = await step(mechAToken, job.id, 'complete-service');
  assert.equal(done.json().serviceCompleted, true);
  // The request stays matched until payment closes it.
  assert.equal(done.json().status, 'matched');
});

test('steps are ordered: work needs arrival, service-complete needs work', async () => {
  const job = await matchedJob();
  assert.equal((await step(mechAToken, job.id, 'start-work')).statusCode, 409);
  await step(mechAToken, job.id, 'arrived');
  assert.equal((await step(mechAToken, job.id, 'start-work')).statusCode, 200);
  // completing needs work started — do it on a fresh job that only arrived.
  const job2 = await matchedJob();
  await step(mechAToken, job2.id, 'arrived');
  assert.equal((await step(mechAToken, job2.id, 'complete-service')).statusCode, 409);
});

test('arriving backfills en route', async () => {
  const job = await matchedJob();
  const arrived = await step(mechAToken, job.id, 'arrived');
  assert.equal(arrived.json().arrived, true);
  assert.equal(arrived.json().enRoute, true);
});

test('a step is idempotent and keeps the first timestamp', async () => {
  const job = await matchedJob();
  const first = (await step(mechAToken, job.id, 'navigating')).json();
  const second = (await step(mechAToken, job.id, 'navigating')).json();
  assert.equal(second.navigating, true);
  assert.equal(second.navigatingAt, first.navigatingAt);
});

test('only the assigned mechanic can advance the job', async () => {
  const job = await matchedJob();
  assert.equal((await step(mechBToken, job.id, 'navigating')).statusCode, 404); // a different mechanic
  assert.equal((await step(clientTokenForRole, job.id, 'navigating')).statusCode, 403); // wrong role
});

test('a pending (unmatched) job cannot be advanced', async () => {
  seq += 1;
  const email = `pending${seq}@example.com`;
  await createUser(ctx.db, { email, password: 'a client password', role: 'client' });
  const clientToken = (await signInAs(ctx.app, email, 'a client password', 'mobile')).accessToken;
  const req = (await ctx.app.inject({ method: 'POST', url: '/api/v1/service-requests', headers: bearer(clientToken), payload: { problem: 'Flat', location: 'EDSA', urgency: 'Normal' } })).json();
  // Not assigned to anyone yet → the mechanic is not the assignee → 404.
  assert.equal((await step(mechAToken, req.id, 'navigating')).statusCode, 404);
});
