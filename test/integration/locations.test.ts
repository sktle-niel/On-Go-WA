import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

interface Account {
  id: string;
  token: string;
}

let ctx: TestContext;
let adminToken: string;
let seq = 0;

const api = (method: 'GET' | 'POST', token: string, url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: bearer(token), ...(payload === undefined ? {} : { payload }) });

async function account(role: 'client' | 'mechanic'): Promise<Account> {
  seq += 1;
  const email = `${role}${seq}@example.com`;
  const user = await createUser(ctx.db, { email, password: 'a long password', role, firstName: 'Test', lastName: `User${seq}` });
  return { id: user.id, token: (await signInAs(ctx.app, email, 'a long password', 'mobile')).accessToken };
}

async function approve(mechanic: Account): Promise<void> {
  const filed = await api('POST', mechanic.token, '/verification-requests', {
    name: 'Mechanic',
    email: `approved${seq}@example.com`,
    role: 'mechanic',
  });
  await api('POST', adminToken, `/verification-requests/${filed.json().id}/decision`, { action: 'approved' });
}

/** A LocationUpdate as LocationUpdate.toJson() writes it, a minute old. */
const fix = (latitude: number, longitude: number, extra: Record<string, unknown> = {}) => ({
  point: { latitude, longitude },
  recordedAt: new Date(Date.now() - 60_000).toISOString(),
  accuracyMeters: null,
  source: 'gps',
  userId: null,
  role: null,
  availability: null,
  ...extra,
});

const report = (who: Account, body: Record<string, unknown>) => api('POST', who.token, '/locations', body);

const locationOf = (token: string, userId: string) => api('GET', token, `/users/${userId}/location`);

const nearby = (token: string, mechanicId: string, radiusKm: number | string) =>
  api('GET', token, `/mechanics/${mechanicId}/nearby-jobs?radiusKm=${radiusKm}`);

/** A pending job, booked by a fresh client at the given point. */
async function jobAt(latitude: number | null, longitude: number | null): Promise<{ id: string; client: Account }> {
  const client = await account('client');
  const res = await api('POST', client.token, '/service-requests', {
    problem: 'Flat tire',
    location: 'Somewhere',
    urgency: 'Normal',
    latitude,
    longitude,
  });
  assert.equal(res.statusCode, 201, res.body);
  return { id: res.json().id, client };
}

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin' });
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
});

after(async () => {
  await ctx.close();
});

test('a report is kept for the token holder, whatever userId the body names, and reads back as a LocationUpdate', async () => {
  const mechanic = await account('mechanic');
  const other = await account('client');
  const recordedAt = new Date(Date.now() - 30_000).toISOString();

  const sent = fix(14.5547, 121.0244, { userId: other.id, role: 'mechanic', availability: 'available', accuracyMeters: 12.5, recordedAt });
  assert.equal((await report(mechanic, sent)).statusCode, 204);

  const own = await locationOf(mechanic.token, mechanic.id);
  assert.equal(own.statusCode, 200, own.body);
  assert.deepEqual(own.json(), {
    point: { latitude: 14.5547, longitude: 121.0244 },
    recordedAt,
    accuracyMeters: 12.5,
    source: 'gps',
    userId: mechanic.id,
    role: 'mechanic',
    availability: 'available',
  });
  assert.equal((await locationOf(other.token, other.id)).statusCode, 404, 'nothing was stored for the userId in the body');

  // The next report replaces it, nulls included.
  assert.equal((await report(mechanic, fix(14.6, 121.1, { source: 'lastKnown' }))).statusCode, 204);
  const replaced = (await locationOf(mechanic.token, mechanic.id)).json();
  assert.equal(replaced.source, 'lastKnown');
  assert.equal(replaced.accuracyMeters, null, 'a null accuracy stays null, not 0');
  assert.equal(replaced.availability, null, 'availability left out is unset');
  assert.equal(replaced.role, 'mechanic', 'the role comes from the account when the body leaves it out');
});

test('role must be your own, availability is for mechanics, and a fix must be real', async () => {
  const client = await account('client');
  assert.equal((await report(client, fix(14.5, 121, { role: 'mechanic' }))).statusCode, 400);
  assert.equal((await report(client, fix(14.5, 121, { availability: 'available' }))).statusCode, 400);
  assert.equal((await report(client, fix(91, 121))).statusCode, 400, 'off the planet');
  assert.equal((await report(client, fix(14.5, 121, { source: 'satellite' }))).statusCode, 400);
  assert.equal((await report(client, fix(14.5, 121, { recordedAt: 'yesterday' }))).statusCode, 400);
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  assert.equal((await report(client, fix(14.5, 121, { recordedAt: future }))).statusCode, 400, 'a fix from the future');
  assert.equal((await api('POST', adminToken, '/locations', fix(14.5, 121))).statusCode, 403, 'the console reports no location');
  assert.equal((await report(client, fix(14.5, 121, { role: 'client' }))).statusCode, 204);
});

test('a location is readable by its owner, the console, and the other party of an active job only', async () => {
  const mechanic = await account('mechanic');
  await approve(mechanic);
  const client = await account('client');
  const stranger = await account('client');
  const otherMechanic = await account('mechanic');
  assert.equal((await report(mechanic, fix(14.55, 121.02, { role: 'mechanic', availability: 'available' }))).statusCode, 204);
  assert.equal((await report(client, fix(14.56, 121.03))).statusCode, 204);

  assert.equal((await locationOf(client.token, mechanic.id)).statusCode, 404, 'not matched yet');
  assert.equal((await locationOf(adminToken, mechanic.id)).statusCode, 200);

  const booked = await api('POST', client.token, '/service-requests', { problem: 'Wont start', location: 'EDSA', urgency: 'Normal' });
  const quote = await api('POST', mechanic.token, `/service-requests/${booked.json().id}/quotes`, { price: 500, etaMinutes: 30 });
  const accepted = await api('POST', client.token, `/service-requests/${booked.json().id}/quotes/${quote.json().id}/accept`);
  assert.equal(accepted.statusCode, 200, accepted.body);

  assert.equal((await locationOf(client.token, mechanic.id)).statusCode, 200, 'the client follows their mechanic');
  assert.equal((await locationOf(mechanic.token, client.id)).statusCode, 200, 'the mechanic finds their client');
  assert.equal((await locationOf(stranger.token, mechanic.id)).statusCode, 404);
  assert.equal((await locationOf(otherMechanic.token, client.id)).statusCode, 404);
  assert.equal((await locationOf(adminToken, stranger.id)).statusCode, 404, 'never reported');
});

test('nearby jobs follow isJobWithinServiceRadius: inside, on the edge, outside, and never without coordinates', async () => {
  const mechanic = await account('mechanic');
  assert.equal((await report(mechanic, fix(10.3157, 123.8854, { role: 'mechanic', availability: 'available' }))).statusCode, 204);
  const near = await jobAt(10.3257, 123.8854);
  const far = await jobAt(10.7157, 123.8854);
  const unplaced = await jobAt(null, null);
  const closed = await jobAt(10.316, 123.885);
  assert.equal((await api('POST', closed.client.token, `/service-requests/${closed.id}/cancel`, {})).statusCode, 200);

  const ids = async (radiusKm: number) => {
    const res = await nearby(mechanic.token, mechanic.id, radiusKm);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as string[];
  };

  const within10 = await ids(10);
  assert.ok(within10.includes(near.id));
  assert.ok(!within10.includes(far.id));
  assert.ok(!within10.includes(unplaced.id), 'a job without coordinates is never nearby');
  assert.ok(!within10.includes(closed.id), 'only pending jobs');

  const edge = await ctx.db.queryOne<{ km: number }>(
    `SELECT ongo_great_circle_m($1::float8, $2::float8, $3::float8, $4::float8) / 1000 AS km`,
    [10.3157, 123.8854, 10.7157, 123.8854],
  );
  const km = edge?.km ?? 0;
  assert.ok(km > 40 && km < 50, `about 44 km, got ${km}`);
  assert.ok((await ids(km)).includes(far.id), 'a radius equal to the distance includes the job');
  assert.ok(!(await ids(km - 1e-9)).includes(far.id), 'just short of it does not');

  const both = await ids(km);
  assert.ok(both.indexOf(near.id) < both.indexOf(far.id), 'nearest first');

  assert.deepEqual(await ids(0), [], 'no radius, no jobs');
  assert.deepEqual(await ids(-5), []);
});

test('an unavailable mechanic gets no nearby jobs, and unset availability counts as available', async () => {
  const mechanic = await account('mechanic');
  const job = await jobAt(7.0731, 125.6128);
  const at = (availability: string | null) => fix(7.0731, 125.6128, { role: 'mechanic', availability });

  await report(mechanic, at('onJob'));
  assert.deepEqual((await nearby(mechanic.token, mechanic.id, 5)).json(), []);
  await report(mechanic, at('offline'));
  assert.deepEqual((await nearby(mechanic.token, mechanic.id, 5)).json(), []);
  await report(mechanic, at(null));
  assert.ok((await nearby(mechanic.token, mechanic.id, 5)).json().includes(job.id));
});

test('only the mechanic themself or the console may ask for nearby jobs', async () => {
  const mechanic = await account('mechanic');
  const otherMechanic = await account('mechanic');
  const client = await account('client');

  assert.equal((await nearby(otherMechanic.token, mechanic.id, 10)).statusCode, 404);
  assert.equal((await nearby(client.token, mechanic.id, 10)).statusCode, 403);
  const asConsole = await nearby(adminToken, mechanic.id, 10);
  assert.equal(asConsole.statusCode, 200, asConsole.body);
  assert.deepEqual(asConsole.json(), [], 'a mechanic who never reported has none');
  assert.equal((await nearby(adminToken, client.id, 10)).statusCode, 404, 'not a mechanic');
  assert.equal((await nearby(mechanic.token, mechanic.id, 'far')).statusCode, 400);
});

test('a booking sent with null coordinates stores none, not 0,0', async () => {
  const job = await jobAt(null, null);
  const stored = await ctx.db.queryOne<{ latitude: number | null; longitude: number | null }>(
    `SELECT latitude, longitude FROM service_requests WHERE id = $1`,
    [job.id],
  );
  assert.deepEqual(stored, { latitude: null, longitude: null });
});
