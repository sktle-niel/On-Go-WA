import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createGcsStorage } from '../../src/storage/gcs.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';
import { fakeGoogle } from '../helpers/fake-google.js';

const BUCKET = 'ongo-test-uploads';
const google = fakeGoogle(BUCKET);

let ctx: TestContext;
let adminToken: string;

const png = (label: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`fake png ${label}`)]);

function multipart(file: Buffer): { body: Buffer; contentType: string } {
  const boundary = '----ongo-gcs-test-boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="background.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function publish(file: Buffer): Promise<{ key: string; path: string }> {
  const { body, contentType } = multipart(file);
  const res = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/platform/appearance',
    headers: { ...bearer(adminToken), 'content-type': contentType },
    payload: body,
  });
  assert.equal(res.statusCode, 200, res.body);
  const path = new URL(res.json().authBackgroundUrl, 'http://api.local').pathname;
  return { key: path.replace('/api/v1/files/', ''), path };
}

before(async () => {
  ctx = await createTestApp({ storage: (config) => createGcsStorage(config, { bucket: BUCKET, fetch: google.fetch }) });
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin' });
  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
});

after(async () => {
  await ctx.close();
});

test('with the gcs driver, a background lands in the bucket, the API serves it, and replacing or clearing it removes the object', async () => {
  const first = await publish(png('first'));
  assert.match(first.key, /^public\/background\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual(google.objects.get(first.key)?.body, png('first'));

  const served = await ctx.app.inject({ method: 'GET', url: first.path });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.deepEqual(served.rawPayload, png('first'));

  const second = await publish(png('second'));
  assert.equal(google.objects.has(first.key), false, 'the replaced background is deleted from the bucket');
  assert.deepEqual(google.objects.get(second.key)?.body, png('second'));

  const cleared = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/platform/appearance', headers: bearer(adminToken) });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(google.objects.size, 0, 'clearing the background empties the bucket');
  assert.equal((await ctx.app.inject({ method: 'GET', url: second.path })).statusCode, 404);
});
