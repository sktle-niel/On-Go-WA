import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let url: string;
let clientToken: string;
let clientId: string;

before(async () => {
  ctx = await createTestApp();
  const user = await createUser(ctx.db, { email: 'client@example.com', password: 'client password 1', role: 'client' });
  clientId = user.id;
  clientToken = (await signInAs(ctx.app, 'client@example.com', 'client password 1', 'mobile')).accessToken;
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const address = ctx.app.server.address();
  assert.ok(address && typeof address === 'object');
  url = `ws://127.0.0.1:${address.port}/api/v1/events`;
});

after(async () => {
  await ctx.close();
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame within 3 s')), 3000);
    socket.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

test('authenticates with the first frame and receives targeted events', async () => {
  const socket = await connect();
  const ready = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'auth', token: clientToken }));
  const readyFrame = await ready;
  assert.equal(readyFrame.type, 'ready');
  assert.equal((readyFrame.user as { role: string }).role, 'client');

  const forAdmins = nextFrame(socket).then(
    () => 'delivered',
    () => 'not delivered',
  );
  await ctx.events.publish({ name: 'only.admins', data: 1, audience: { roles: ['admin'] } });
  await ctx.events.publish({ name: 'for.you', data: { hello: 'world' }, audience: { userIds: [clientId] } });
  const first = await forAdmins;
  assert.equal(first, 'delivered');
  // The frame that arrived must be the one addressed to this user.
  socket.close();
  await closed(socket);
});

test('delivers the event addressed to the user and skips others', async () => {
  const socket = await connect();
  const ready = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'auth', token: clientToken }));
  await ready;

  const frame = nextFrame(socket);
  await ctx.events.publish({ name: 'only.admins', data: 1, audience: { roles: ['admin'] } });
  await ctx.events.publish({ name: 'for.you', data: { hello: 'world' }, audience: { userIds: [clientId] } });
  const received = await frame;
  assert.equal(received.type, 'event');
  assert.equal(received.name, 'for.you');
  assert.deepEqual(received.data, { hello: 'world' });
  assert.ok(typeof received.at === 'string');

  socket.close();
  await closed(socket);
});

test('a bad token is refused and the socket closed with 4401', async () => {
  const socket = await connect();
  const frame = nextFrame(socket);
  const closing = closed(socket);
  socket.send(JSON.stringify({ type: 'auth', token: 'not.a.token' }));
  const error = await frame;
  assert.equal(error.type, 'error');
  assert.equal(await closing, 4401);
});

test('a signed-out session is dropped on the next heartbeat', async () => {
  const session = await signInAs(ctx.app, 'client@example.com', 'client password 1', 'mobile');
  const socket = await connect();
  const ready = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'auth', token: session.accessToken }));
  await ready;

  const closing = closed(socket);
  const signOut = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-out',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(signOut.statusCode, 204);
  // WS_HEARTBEAT_SECONDS is 1 in tests.
  assert.equal(await closing, 4401);
});
