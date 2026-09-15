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
const events: PlatformEvent[] = [];
let seq = 0;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake chat photo')]);

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
  const user = await createUser(ctx.db, { email, password: 'a client password', role: 'client', firstName: 'Carla', lastName: 'Client' });
  return { id: user.id, token: (await signInAs(ctx.app, email, 'a client password', 'mobile')).accessToken };
}

/** Books a Normal job for `client` and matches it to `mechanic` through a quote. */
async function matchedJob(client: Account, mechanic: Account): Promise<string> {
  const booked = await api('POST', client.token, '/service-requests', { problem: 'Wont start', location: 'EDSA', urgency: 'Normal' });
  assert.equal(booked.statusCode, 201, booked.body);
  const id = booked.json().id as string;
  const quote = await api('POST', mechanic.token, `/service-requests/${id}/quotes`, { price: 500, etaMinutes: 30 });
  assert.equal(quote.statusCode, 201, quote.body);
  const accepted = await api('POST', client.token, `/service-requests/${id}/quotes/${quote.json().id}/accept`);
  assert.equal(accepted.statusCode, 200, accepted.body);
  return id;
}

const say = (who: Account, id: string, body: string, replyToId?: string) =>
  api('POST', who.token, `/service-requests/${id}/chat`, replyToId ? { body, replyToId } : { body });

const thread = (who: Account, id: string, query = '') => api('GET', who.token, `/service-requests/${id}/chat${query}`);

function photo(who: Account, id: string, data: Buffer, fields: Record<string, string> = {}) {
  const boundary = `----ongo-chat-${seq}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/service-requests/${id}/chat/images`,
    headers: { ...bearer(who.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
}

const bodies = (res: { json(): { messages: Array<{ body: string | null }> } }) => res.json().messages.map((m) => m.body);

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin' });
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
  ctx.events.subscribe((event) => events.push(event));
});

beforeEach(() => {
  events.length = 0;
});

after(async () => {
  await ctx.close();
});

test('the client and the matched mechanic exchange messages; unread counts follow each read marker', async () => {
  const mech = await approvedMechanic('Mike');
  const client = await newClient();
  const id = await matchedJob(client, mech);

  const hello = await say(client, id, '  I am by the blue gate  ');
  assert.equal(hello.statusCode, 201, hello.body);
  const first = hello.json();
  assert.equal(first.body, 'I am by the blue gate', 'text is trimmed');
  assert.equal(first.senderRole, 'client');
  assert.equal(first.senderId, client.id);
  assert.equal(first.senderName, 'Carla Client');
  assert.equal(first.imageUrl, null);

  const created = events.find((event) => event.name === 'chat_message.created');
  assert.ok(created, 'the message is announced');
  assert.deepEqual([...(created.audience?.userIds ?? [])].sort(), [client.id, mech.id].sort());

  const reply = await say(mech, id, 'On my way', first.id);
  assert.equal(reply.statusCode, 201, reply.body);
  assert.equal(reply.json().replyToId, first.id);
  assert.equal((await say(mech, id, 'Five minutes')).statusCode, 201);

  const clientView = await thread(client, id);
  assert.equal(clientView.statusCode, 200, clientView.body);
  assert.equal(clientView.json().open, true);
  assert.equal(clientView.json().otherPartyName, 'Mike Mech');
  assert.equal(clientView.json().unreadCount, 2);
  assert.deepEqual(bodies(clientView), ['I am by the blue gate', 'On my way', 'Five minutes']);

  assert.equal((await thread(mech, id)).json().unreadCount, 0, 'sending counts as reading up to your own message');

  const upTo = await api('POST', client.token, `/service-requests/${id}/chat/read`, { upToMessageId: reply.json().id });
  assert.equal(upTo.statusCode, 200, upTo.body);
  assert.equal(upTo.json().unreadCount, 1);

  const everything = await api('POST', client.token, `/service-requests/${id}/chat/read`, {});
  assert.equal(everything.json().unreadCount, 0);
  assert.ok(everything.json().lastReadAt);

  const back = await api('POST', client.token, `/service-requests/${id}/chat/read`, { upToMessageId: first.id });
  assert.equal(back.json().unreadCount, 0, 'a read marker never moves back');
});

test('only the two parties can open the chat; everyone else is told the job does not exist', async () => {
  const mech = await approvedMechanic('Mona');
  const other = await approvedMechanic('Otto');
  const client = await newClient();
  const stranger = await newClient();
  const id = await matchedJob(client, mech);

  for (const outsider of [other, stranger]) {
    assert.equal((await thread(outsider, id)).statusCode, 404);
    assert.equal((await say(outsider, id, 'hi')).statusCode, 404);
    assert.equal((await photo(outsider, id, PNG)).statusCode, 404);
  }
  assert.equal((await api('GET', adminToken, `/service-requests/${id}/chat`)).statusCode, 403, 'console roles have no chat');
});

test('before a mechanic takes the job there is no one to message', async () => {
  const client = await newClient();
  const booked = await api('POST', client.token, '/service-requests', { problem: 'Flat tire', location: 'EDSA', urgency: 'Normal' });
  const id = booked.json().id as string;

  const view = (await thread(client, id)).json();
  assert.deepEqual(
    { open: view.open, otherPartyName: view.otherPartyName, messages: view.messages, unreadCount: view.unreadCount },
    { open: false, otherPartyName: null, messages: [], unreadCount: 0 },
  );
  assert.equal((await say(client, id, 'anyone?')).statusCode, 409);
});

test('a reply must point at a message in the same chat, and a message needs text', async () => {
  const mech = await approvedMechanic('Rita');
  const a = await newClient();
  const b = await newClient();
  const jobA = await matchedJob(a, mech);
  const jobB = await matchedJob(b, mech);

  const inA = (await say(a, jobA, 'hello')).json();
  assert.equal((await say(b, jobB, 'is this about me?', inA.id)).statusCode, 400);
  assert.equal((await say(a, jobA, '   ')).statusCode, 400);
  assert.equal((await say(a, jobA, 'x'.repeat(2001))).statusCode, 400);
  assert.equal((await thread(a, jobA, `?before=${jobA}`)).statusCode, 400, 'a cursor must be a message in this chat');
});

test('a photo travels as a signed link the API serves, and only real images are accepted', async () => {
  const mech = await approvedMechanic('Pia');
  const client = await newClient();
  const id = await matchedJob(client, mech);

  const sent = await photo(mech, id, PNG, { body: 'The broken belt' });
  assert.equal(sent.statusCode, 201, sent.body);
  const message = sent.json();
  assert.equal(message.body, 'The broken belt');
  const link = new URL(message.imageUrl, 'http://api.local');
  assert.match(link.pathname, /^\/api\/v1\/files\/chat\/[0-9a-f-]{36}\.png$/);

  const served = await ctx.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.deepEqual(served.rawPayload, PNG);
  assert.equal((await ctx.app.inject({ method: 'GET', url: link.pathname })).statusCode, 403, 'never without the signature');

  const uncaptioned = await photo(client, id, PNG, { replyToId: message.id });
  assert.equal(uncaptioned.statusCode, 201, uncaptioned.body);
  assert.equal(uncaptioned.json().body, null);
  assert.equal(uncaptioned.json().replyToId, message.id);

  assert.equal((await photo(client, id, Buffer.from('plain text, not an image'))).statusCode, 400);
  assert.equal((await photo(client, id, PNG, { replyToId: 'not-an-id' })).statusCode, 400);
});

test('once the job is paid the chat is closed, and its history stays readable to both', async () => {
  const mech = await approvedMechanic('Paul');
  const client = await newClient();
  const id = await matchedJob(client, mech);
  assert.equal((await say(client, id, 'Thanks for coming')).statusCode, 201);

  for (const step of ['arrived', 'start-work', 'complete-service']) {
    assert.equal((await api('POST', mech.token, `/service-requests/${id}/${step}`)).statusCode, 200);
  }
  const paid = await api('POST', client.token, `/service-requests/${id}/pay`, {});
  assert.equal(paid.statusCode, 200, paid.body);

  const closed = (await thread(mech, id)).json();
  assert.equal(closed.open, false);
  assert.deepEqual(closed.messages.map((m: { body: string }) => m.body), ['Thanks for coming']);
  assert.equal((await thread(client, id)).statusCode, 200);
  assert.equal((await say(mech, id, 'one more thing')).statusCode, 409);
  assert.equal((await photo(client, id, PNG)).statusCode, 409);
});

test('when a job goes back to the pool, the next mechanic starts with an empty chat and the last one loses access', async () => {
  const firstMech = await approvedMechanic('Ferdie');
  const secondMech = await approvedMechanic('Sam');
  const client = await newClient();
  const id = await matchedJob(client, firstMech);
  assert.equal((await say(client, id, 'Where are you?')).statusCode, 201);
  assert.equal((await say(firstMech, id, 'Stuck in traffic')).statusCode, 201);

  assert.equal((await api('POST', firstMech.token, `/service-requests/${id}/arrived`)).statusCode, 200);
  const reopened = await api('POST', client.token, `/service-requests/${id}/reopen`);
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal((await say(client, id, 'hello?')).statusCode, 409, 'no one to message while the job is in the pool');

  const quote = await api('POST', secondMech.token, `/service-requests/${id}/quotes`, { price: 450, etaMinutes: 20 });
  assert.equal(quote.statusCode, 201, quote.body);
  const accepted = await api('POST', client.token, `/service-requests/${id}/quotes/${quote.json().id}/accept`);
  assert.equal(accepted.statusCode, 200, accepted.body);

  assert.deepEqual((await thread(secondMech, id)).json().messages, []);
  assert.deepEqual((await thread(client, id)).json().messages, [], 'the client sees the new conversation');
  assert.equal((await thread(firstMech, id)).statusCode, 404);
});

test('the thread pages backwards, and the unread summary lists jobs with messages waiting', async () => {
  const mech = await approvedMechanic('Gus');
  const client = await newClient();
  const id = await matchedJob(client, mech);
  for (const text of ['one', 'two', 'three']) {
    assert.equal((await say(mech, id, text)).statusCode, 201);
  }

  const latest = await thread(client, id, '?limit=2');
  assert.deepEqual(bodies(latest), ['two', 'three']);
  assert.equal(latest.json().hasMore, true);
  const older = await thread(client, id, `?limit=2&before=${latest.json().messages[0].id}`);
  assert.deepEqual(bodies(older), ['one']);
  assert.equal(older.json().hasMore, false);

  const summary = await api('GET', client.token, '/chat/unread');
  assert.equal(summary.statusCode, 200, summary.body);
  assert.deepEqual(
    summary.json().map((row: { requestId: string; unreadCount: number }) => [row.requestId, row.unreadCount]),
    [[id, 3]],
  );
  assert.deepEqual((await api('GET', mech.token, '/chat/unread')).json(), [], 'your own messages are never unread');

  await api('POST', client.token, `/service-requests/${id}/chat/read`, {});
  assert.deepEqual((await api('GET', client.token, '/chat/unread')).json(), []);
});
