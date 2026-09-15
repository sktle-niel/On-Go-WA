import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { PlatformEvent } from '../../src/events/bus.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

interface Account {
  id: string;
  token: string;
}

interface Entry {
  rank: number;
  mechanicId: string;
  name: string;
  rating: number;
  reviewCount: number;
  completedJobs: number;
}

let ctx: TestContext;
let admin: Account;
const events: PlatformEvent[] = [];
let seq = 0;

const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', token: string, url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: bearer(token), ...(payload === undefined ? {} : { payload }) });

async function account(role: 'client' | 'mechanic', firstName: string): Promise<Account> {
  seq += 1;
  const email = `${role}${seq}@example.com`;
  const user = await createUser(ctx.db, { email, password: 'a long password', role, firstName, lastName: 'Test' });
  return { id: user.id, token: (await signInAs(ctx.app, email, 'a long password', 'mobile')).accessToken };
}

/** An approved verification request, written straight to the table. */
async function approve(mechanic: Account): Promise<void> {
  await ctx.db.query(
    `INSERT INTO account_requests (user_id, user_number, role, status, reviewed_at, reviewer_id, name, email)
     VALUES ($1, $2, 'mechanic'::requested_role, 'approved'::approval_status, now(), $3, 'Mechanic', 'mechanic@example.com')`,
    [mechanic.id, `TEST-${mechanic.id}`, admin.id],
  );
}

/** A job the mechanic finished and the client paid, written straight to the table. */
async function paidJobBetween(client: Account, mechanic: Account): Promise<string> {
  const row = await ctx.db.queryOne<{ id: string }>(
    `INSERT INTO service_requests (client_id, mechanic_id, status, urgency, issue, completed_at)
     VALUES ($1, $2, 'completed'::request_status, 'Normal'::urgency_level, 'Flat tire', now())
     RETURNING id`,
    [client.id, mechanic.id],
  );
  if (!row) throw new Error('seed job was not written');
  return row.id;
}

const review = (client: Account, mechanicId: string, body: Record<string, unknown>) =>
  api('PUT', client.token, `/mechanics/${mechanicId}/review`, body);

const reviewsOf = (token: string, mechanicId: string) => api('GET', token, `/mechanics/${mechanicId}/reviews`);

before(async () => {
  ctx = await createTestApp();
  const user = await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin' });
  admin = { id: user.id, token: (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken };
  ctx.events.subscribe((event) => events.push(event));
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  events.length = 0;
});

test('after a paid job the client reviews the mechanic, and submitting again edits that one review', async () => {
  const mechanic = await account('mechanic', 'Mike');
  const filed = await api('POST', mechanic.token, '/verification-requests', { name: 'Mike Test', email: 'mike@example.com', role: 'mechanic' });
  await api('POST', admin.token, `/verification-requests/${filed.json().id}/decision`, { action: 'approved' });
  const client = await account('client', 'Cita');

  const id = (await api('POST', client.token, '/service-requests', { problem: 'Wont start', location: 'EDSA', urgency: 'Normal' })).json().id;
  const quote = await api('POST', mechanic.token, `/service-requests/${id}/quotes`, { price: 500, etaMinutes: 30 });
  assert.equal((await api('POST', client.token, `/service-requests/${id}/quotes/${quote.json().id}/accept`)).statusCode, 200);

  assert.equal((await review(client, mechanic.id, { rating: 5 })).statusCode, 403, 'not while the job is unpaid');

  for (const step of ['arrived', 'start-work', 'complete-service']) {
    assert.equal((await api('POST', mechanic.token, `/service-requests/${id}/${step}`)).statusCode, 200);
  }
  assert.equal((await api('POST', client.token, `/service-requests/${id}/pay`, {})).statusCode, 200);
  events.length = 0;

  const first = await review(client, mechanic.id, { rating: 5, comment: '  Fast and friendly  ' });
  assert.equal(first.statusCode, 200, first.body);
  const saved = first.json();
  assert.equal(saved.rating, 5);
  assert.equal(saved.comment, 'Fast and friendly');
  assert.equal(saved.clientName, 'Cita Test');
  assert.equal(saved.requestId, id);
  assert.equal(saved.helpfulCount, 0);
  const told = events.find((e) => e.name === 'review.submitted');
  assert.deepEqual(told?.audience?.userIds, [mechanic.id], 'the mechanic hears they were rated');

  const edited = await review(client, mechanic.id, { rating: 3, comment: 'Late next time' });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().id, saved.id, 'one review per client per mechanic');
  assert.equal(edited.json().rating, 3);
  assert.equal(edited.json().comment, 'Late next time');
  assert.ok(Date.parse(edited.json().updatedAt) >= Date.parse(saved.updatedAt));

  const listed = (await reviewsOf(client.token, mechanic.id)).json();
  assert.equal(listed.count, 1);
  assert.equal(listed.average, 3);
});

test('only a client the mechanic served may review, with a whole-star rating', async () => {
  const mechanic = await account('mechanic', 'Nina');
  const client = await account('client', 'Carl');

  assert.equal((await review(client, mechanic.id, { rating: 4 })).statusCode, 403, 'no job together');
  await paidJobBetween(client, mechanic);

  assert.equal((await api('PUT', mechanic.token, `/mechanics/${mechanic.id}/review`, { rating: 5 })).statusCode, 403, 'mechanics do not review');
  assert.equal((await review(client, client.id, { rating: 4 })).statusCode, 404, 'not a mechanic');
  for (const rating of [0, 6, 4.5, 'great']) {
    assert.equal((await review(client, mechanic.id, { rating })).statusCode, 400, `rating ${rating}`);
  }
  assert.equal((await review(client, mechanic.id, { rating: 4 })).statusCode, 200);
});

test("a mechanic's reviews come newest first, with the average and distribution the profile shows", async () => {
  const mechanic = await account('mechanic', 'Olga');
  const early = await account('client', 'Early');
  const late = await account('client', 'Late');
  await paidJobBetween(early, mechanic);
  await paidJobBetween(late, mechanic);
  assert.equal((await review(early, mechanic.id, { rating: 5 })).statusCode, 200);
  assert.equal((await review(late, mechanic.id, { rating: 2, comment: 'Meh' })).statusCode, 200);

  const res = await reviewsOf(early.token, mechanic.id);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.count, 2);
  assert.equal(body.average, 3.5);
  assert.deepEqual(body.distribution, { '1': 0, '2': 0.5, '3': 0, '4': 0, '5': 0.5 });
  assert.deepEqual(body.reviews.map((r: { clientName: string }) => r.clientName), ['Late Test', 'Early Test']);

  const unreviewed = await account('mechanic', 'Pia');
  const none = (await reviewsOf(early.token, unreviewed.id)).json();
  assert.deepEqual(
    { count: none.count, average: none.average, reviews: none.reviews, distribution: none.distribution },
    { count: 0, average: 0, reviews: [], distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } },
  );
  assert.equal((await reviewsOf(early.token, early.id)).statusCode, 404, 'not a mechanic');
});

test('anyone on the app marks a review helpful once, and can take the mark back', async () => {
  const mechanic = await account('mechanic', 'Quinn');
  const author = await account('client', 'Author');
  const reader = await account('client', 'Reader');
  await paidJobBetween(author, mechanic);
  const id = (await review(author, mechanic.id, { rating: 4 })).json().id as string;
  const mark = (token: string, method: 'PUT' | 'DELETE') => api(method, token, `/reviews/${id}/helpful`);

  assert.deepEqual((await mark(reader.token, 'PUT')).json(), { reviewId: id, helpfulCount: 1, likedByMe: true });
  assert.equal((await mark(reader.token, 'PUT')).json().helpfulCount, 1, 'once per person');
  assert.equal((await mark(mechanic.token, 'PUT')).json().helpfulCount, 2, 'the mechanic may mark it too');

  const asReader = (await reviewsOf(reader.token, mechanic.id)).json().reviews[0];
  assert.deepEqual([asReader.helpfulCount, asReader.likedByMe], [2, true]);
  const asAuthor = (await reviewsOf(author.token, mechanic.id)).json().reviews[0];
  assert.equal(asAuthor.likedByMe, false);

  assert.deepEqual((await mark(reader.token, 'DELETE')).json(), { reviewId: id, helpfulCount: 1, likedByMe: false });
  assert.equal((await mark(reader.token, 'DELETE')).statusCode, 200, 'taking it back twice is fine');
  assert.equal((await mark(admin.token, 'PUT')).statusCode, 403, 'the console does not mark reviews');
  assert.equal((await api('PUT', reader.token, `/reviews/${mechanic.id}/helpful`)).statusCode, 404);
});

test('the leaderboard ranks approved mechanics by rating or by reviews, and searches by name literally', async () => {
  const alpha = await account('mechanic', 'Alpha');
  const bravo = await account('mechanic', 'Bravo');
  const charlie = await account('mechanic', 'Charlie');
  const unapproved = await account('mechanic', 'Delta');
  for (const mechanic of [alpha, bravo, charlie]) await approve(mechanic);

  const seedReview = async (mechanic: Account, rating: number) => {
    const client = await account('client', 'Rater');
    await paidJobBetween(client, mechanic);
    await ctx.db.query(`INSERT INTO reviews (client_id, mechanic_id, rating) VALUES ($1, $2, $3::smallint)`, [client.id, mechanic.id, rating]);
  };
  await seedReview(alpha, 5);
  await seedReview(bravo, 4);
  await seedReview(bravo, 4);
  await seedReview(unapproved, 5);

  const board = async (query = '') => {
    const res = await api('GET', alpha.token, `/leaderboard${query}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as Entry[];
  };
  const mine = [alpha.id, bravo.id, charlie.id, unapproved.id];
  const ours = (entries: Entry[]) => entries.filter((e) => mine.includes(e.mechanicId));

  const byRating = ours(await board());
  assert.deepEqual(byRating.map((e) => e.name), ['Alpha Test', 'Bravo Test', 'Charlie Test'], 'an unapproved mechanic is not ranked');
  assert.deepEqual(
    byRating.map((e) => [e.rating, e.reviewCount, e.completedJobs]),
    [
      [5, 1, 1],
      [4, 2, 2],
      [0, 0, 0],
    ],
  );
  assert.ok(byRating[0]!.rank < byRating[1]!.rank && byRating[1]!.rank < byRating[2]!.rank);

  const byReviews = ours(await board('?sort=reviews'));
  assert.deepEqual(byReviews.map((e) => e.name), ['Bravo Test', 'Alpha Test', 'Charlie Test']);

  const full = await board();
  const found = await board('?search=bra');
  assert.deepEqual(found.map((e) => e.name), ['Bravo Test']);
  assert.equal(found[0]!.rank, full.find((e) => e.mechanicId === bravo.id)!.rank, 'rank is overall, not within the search');
  assert.deepEqual(await board('?search=%25'), [], 'a % in the search is a literal, not a wildcard');
});
