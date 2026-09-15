import '../helpers/env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/config/env.js';
import { createGcsStorage, metadataAccessToken } from '../../src/storage/gcs.js';
import { verifyKeySignature } from '../../src/storage/storage.js';
import { fakeGoogle } from '../helpers/fake-google.js';

const BUCKET = 'ongo-test-uploads';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png bytes')]);
const A_KEY = 'documents/00000000-0000-4000-8000-000000000000.png';

function setup(options?: Parameters<typeof fakeGoogle>[1]) {
  const google = fakeGoogle(BUCKET, options);
  const storage = createGcsStorage(loadConfig(), { bucket: BUCKET, fetch: google.fetch });
  return { google, storage };
}

test('stores, reads and deletes through the Cloud Storage JSON API with the service account token', async () => {
  const { google, storage } = setup();

  const stored = await storage.put({ kind: 'document', ext: 'png', body: PNG });
  assert.match(stored.key, /^documents\/[0-9a-f-]{36}\.png$/);
  assert.equal(stored.bytes, PNG.byteLength);
  assert.deepEqual(google.objects.get(stored.key)?.body, PNG);

  const upload = google.calls.find((call) => call.method === 'POST');
  assert.ok(upload);
  assert.equal(upload.url.searchParams.get('name'), stored.key);
  assert.equal(upload.url.searchParams.get('ifGenerationMatch'), '0', 'create only, never overwrite');
  assert.equal(upload.headers['Content-Type'], 'image/png');
  assert.equal(upload.headers.Authorization, 'Bearer fake-token-1');

  assert.deepEqual(await storage.read(stored.key), { body: PNG, contentType: 'image/png' });
  const download = google.calls.find((call) => call.method === 'GET' && call.url.hostname === 'storage.googleapis.com');
  assert.ok(download?.url.pathname.includes('documents%2F'), 'the key travels as one encoded path segment');

  await storage.delete(stored.key);
  assert.equal(google.objects.size, 0);
  assert.equal(await storage.read(stored.key), null, 'a missing object reads as null');
  await storage.delete(stored.key);

  assert.equal(google.tokensIssued(), 1, 'one token served every call');
});

test('a background is public and a document link is signed; the API serves both', async () => {
  const config = loadConfig();
  const { storage } = setup();

  const background = await storage.put({ kind: 'background', ext: 'png', body: PNG });
  assert.match(background.key, /^public\/background\//);
  assert.equal(new URL(storage.publicUrl(background.key), 'http://api.local').pathname, `/api/v1/files/${background.key}`);

  const document = await storage.put({ kind: 'document', ext: 'png', body: PNG });
  assert.throws(() => storage.publicUrl(document.key), /non-public/);
  const link = new URL(storage.signedUrl(document.key, 60), 'http://api.local');
  assert.equal(link.pathname, `/api/v1/files/${document.key}`);
  assert.ok(
    verifyKeySignature(config.JWT_SIGNING_KEY, document.key, Number(link.searchParams.get('exp')), link.searchParams.get('sig') ?? ''),
  );
});

test('the content type served comes from the key, not from what the bucket holds', async () => {
  const { google, storage } = setup();
  const stored = await storage.put({ kind: 'document', ext: 'pdf', body: Buffer.from('%PDF-1.7 fake') });
  const object = google.objects.get(stored.key);
  assert.ok(object);
  object.contentType = 'text/html';
  assert.equal((await storage.read(stored.key))?.contentType, 'application/pdf');
});

test('an unsafe key never reaches the network', async () => {
  const { google, storage } = setup();
  for (const key of ['../escape.png', 'documents/../../escape.png', 'documents/not-a-uuid.png', 'public/../documents/x.png']) {
    await assert.rejects(storage.read(key), /unsafe storage key/);
    await assert.rejects(storage.delete(key), /unsafe storage key/);
  }
  assert.equal(google.calls.length, 0);
});

test('a Cloud Storage failure is an error that carries the status and never the token', async () => {
  const { storage } = setup({ storageStatus: 503 });
  await assert.rejects(
    storage.put({ kind: 'document', ext: 'png', body: PNG }),
    (err: Error) => err.message.includes('503') && !err.message.includes('fake-token'),
  );
  await assert.rejects(storage.read(A_KEY), /503/);
  await assert.rejects(storage.delete(A_KEY), /503/);
});

test('the metadata token is fetched once for concurrent callers and renewed inside its last minute', async () => {
  const longLived = fakeGoogle(BUCKET);
  const token = metadataAccessToken(longLived.fetch);
  const first = await Promise.all([token(), token(), token()]);
  await token();
  assert.equal(longLived.tokensIssued(), 1);
  assert.deepEqual(new Set(first).size, 1);

  const shortLived = fakeGoogle(BUCKET, { tokenTtlSeconds: 30 });
  const renewing = metadataAccessToken(shortLived.fetch);
  await renewing();
  await renewing();
  assert.equal(shortLived.tokensIssued(), 2);
});

test('the driver refuses to start without a bucket', () => {
  assert.throws(() => createGcsStorage(loadConfig(), { bucket: '' }), /GCS_BUCKET/);
});
