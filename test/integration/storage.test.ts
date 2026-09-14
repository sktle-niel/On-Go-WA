import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { loadConfig } from '../../src/config/env.js';
import type { PlatformEvent } from '../../src/events/bus.js';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let adminToken: string;
let mechanicToken: string;
let otherMechanicToken: string;
let clientToken: string;

const events: PlatformEvent[] = [];

// Minimal buffers whose leading bytes are the real magic numbers the sniffer checks.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('ongo-png-payload')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('ongo-jpeg-payload')]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('ongo-pdf-payload')]);
const TEXT = Buffer.from('just some text, not an allowed type');

function multipartBody(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----ongo${Date.now()}${Math.floor(Date.now() % 100000)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const upload = (token: string, url: string, fields: Record<string, string>, file: Parameters<typeof multipartBody>[1]) => {
  const { body, contentType } = multipartBody(fields, file);
  return ctx.app.inject({ method: url.startsWith('/api/v1/platform') ? 'PUT' : 'POST', url, headers: { ...bearer(token), 'content-type': contentType }, payload: body });
};

before(async () => {
  ctx = await createTestApp();
  await createUser(ctx.db, { email: 'admin@example.com', password: 'admin password 1', role: 'admin', firstName: 'Ada', lastName: 'Admin' });
  await createUser(ctx.db, { email: 'mech@example.com', password: 'mech password 1', role: 'mechanic' });
  await createUser(ctx.db, { email: 'other@example.com', password: 'other password 1', role: 'mechanic' });
  await createUser(ctx.db, { email: 'client@example.com', password: 'client password 1', role: 'client' });

  adminToken = (await signInAs(ctx.app, 'admin@example.com', 'admin password 1', 'console')).accessToken;
  mechanicToken = (await signInAs(ctx.app, 'mech@example.com', 'mech password 1', 'mobile')).accessToken;
  otherMechanicToken = (await signInAs(ctx.app, 'other@example.com', 'other password 1', 'mobile')).accessToken;
  clientToken = (await signInAs(ctx.app, 'client@example.com', 'client password 1', 'mobile')).accessToken;

  ctx.events.subscribe((event) => events.push(event));
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  events.length = 0;
});

let seq = 0;
// A fresh mechanic with a fresh pending request, so the one-pending-per-user
// rule never collides across tests.
async function freshRequest(): Promise<{ id: string; token: string }> {
  seq += 1;
  const email = `docmech${seq}@example.com`;
  await createUser(ctx.db, { email, password: 'a mechanic password', role: 'mechanic' });
  const token = (await signInAs(ctx.app, email, 'a mechanic password', 'mobile')).accessToken;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/verification-requests',
    headers: bearer(token),
    payload: { name: 'Doc Mech', email, role: 'mechanic' },
  });
  return { id: res.json().id, token };
}

test('a document is uploaded and served through a signed URL', async () => {
  const request = await freshRequest();

  const res = await upload(request.token, `/api/v1/verification-requests/${request.id}/documents`, { kind: 'mechanic_id', label: 'My ID' }, { field: 'file', filename: 'id.png', contentType: 'image/png', data: PNG });
  assert.equal(res.statusCode, 201, res.body);
  const dto = res.json();
  assert.equal(dto.documents.length, 1);
  const doc = dto.documents[0];
  assert.equal(doc.kind, 'mechanic_id');
  assert.equal(doc.label, 'My ID');
  assert.equal(doc.fileName, 'id.png');
  assert.equal(doc.ownerName, 'Doc Mech');
  assert.match(doc.uri, /\/api\/v1\/files\/documents\/[0-9a-f-]+\.png\?exp=\d+&sig=/);

  // The signed URL serves the bytes.
  const fetched = await ctx.app.inject({ method: 'GET', url: doc.uri });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.headers['content-type'], 'image/png');
  assert.deepEqual(fetched.rawPayload, PNG);

  // The owner sees the document on the socket.
  assert.ok(events.some((e) => e.name === 'verification_request.updated' && (e.data as { id: string }).id === request.id));
});

test('a tampered or unsigned document URL is refused', async () => {
  const request = await freshRequest();
  const dto = (await upload(request.token, `/api/v1/verification-requests/${request.id}/documents`, {}, { field: 'file', filename: 'x.jpg', contentType: 'image/jpeg', data: JPEG })).json();
  const uri = dto.documents[0].uri as string;

  const tampered = uri.replace(/sig=.*/, 'sig=forged');
  assert.equal((await ctx.app.inject({ method: 'GET', url: tampered })).statusCode, 403);

  const unsigned = uri.replace(/\?.*/, '');
  assert.equal((await ctx.app.inject({ method: 'GET', url: unsigned })).statusCode, 403);
});

test('only the owning mechanic can attach, and only while pending', async () => {
  const request = await freshRequest();

  // Another mechanic cannot attach to it.
  const stranger = await upload(otherMechanicToken, `/api/v1/verification-requests/${request.id}/documents`, {}, { field: 'file', filename: 'x.png', contentType: 'image/png', data: PNG });
  assert.equal(stranger.statusCode, 404);

  // A client role cannot reach the route at all.
  const client = await upload(clientToken, `/api/v1/verification-requests/${request.id}/documents`, {}, { field: 'file', filename: 'x.png', contentType: 'image/png', data: PNG });
  assert.equal(client.statusCode, 403);

  // Once decided, no more documents.
  await ctx.app.inject({ method: 'POST', url: `/api/v1/verification-requests/${request.id}/decision`, headers: bearer(adminToken), payload: { action: 'approved' } });
  const late = await upload(request.token, `/api/v1/verification-requests/${request.id}/documents`, {}, { field: 'file', filename: 'x.png', contentType: 'image/png', data: PNG });
  assert.equal(late.statusCode, 409);
});

test('the declared type is not trusted — the bytes must match an allowed type', async () => {
  const request = await freshRequest();
  // A text file dressed up as a PNG is rejected by its bytes.
  const res = await upload(request.token, `/api/v1/verification-requests/${request.id}/documents`, {}, { field: 'file', filename: 'sneaky.png', contentType: 'image/png', data: TEXT });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'validation_failed');
});

test('a PDF is accepted as a document', async () => {
  const request = await freshRequest();
  const res = await upload(request.token, `/api/v1/verification-requests/${request.id}/documents`, { kind: 'certification' }, { field: 'file', filename: 'cert.pdf', contentType: 'application/pdf', data: PDF });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().documents[0].kind, 'certification');
});

test('a request caps how many documents it can hold', async () => {
  const request = await freshRequest();
  const max = loadConfig().MAX_DOCUMENTS_PER_REQUEST;
  for (let i = 0; i < max; i += 1) {
    const res = await upload(request.token, `/api/v1/verification-requests/${request.id}/documents`, {}, { field: 'file', filename: `d${i}.png`, contentType: 'image/png', data: PNG });
    assert.equal(res.statusCode, 201, res.body);
  }
  const over = await upload(request.token, `/api/v1/verification-requests/${request.id}/documents`, {}, { field: 'file', filename: 'over.png', contentType: 'image/png', data: PNG });
  assert.equal(over.statusCode, 409);
  assert.equal(over.json().error.code, 'conflict');

  // The rejected upload left nothing behind: still exactly `max` documents.
  const dto = (await ctx.app.inject({ method: 'GET', url: `/api/v1/verification-requests/${request.id}`, headers: bearer(request.token) })).json();
  assert.equal(dto.documents.length, max);
});

test('the Sign In background is published, served publicly, and cleared', async () => {
  const put = await upload(adminToken, '/api/v1/platform/appearance', {}, { field: 'file', filename: 'bg.jpg', contentType: 'image/jpeg', data: JPEG });
  assert.equal(put.statusCode, 200, put.body);
  const url = put.json().authBackgroundUrl as string;
  assert.match(url, /\/api\/v1\/files\/public\/background\/[0-9a-f-]+\.jpg$/);
  assert.ok(put.json().updatedAt);
  assert.ok(events.some((e) => e.name === 'platform_appearance.updated'));

  // Public GET returns the URL...
  const fetch = await ctx.app.inject({ method: 'GET', url: '/api/v1/platform/appearance' });
  assert.equal(fetch.json().authBackgroundUrl, url);

  // ...and the URL serves the image with no signature.
  const image = await ctx.app.inject({ method: 'GET', url });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers['content-type'], 'image/jpeg');
  assert.deepEqual(image.rawPayload, JPEG);

  // Clear it.
  const del = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/platform/appearance', headers: bearer(adminToken) });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().authBackgroundUrl, null);
  assert.equal((await ctx.app.inject({ method: 'GET', url })).statusCode, 404);
});

test('the background write side rejects non-images and non-publishers', async () => {
  const client = await upload(clientToken, '/api/v1/platform/appearance', {}, { field: 'file', filename: 'bg.jpg', contentType: 'image/jpeg', data: JPEG });
  assert.equal(client.statusCode, 403);

  const pdf = await upload(adminToken, '/api/v1/platform/appearance', {}, { field: 'file', filename: 'bg.pdf', contentType: 'application/pdf', data: PDF });
  assert.equal(pdf.statusCode, 400);
  assert.equal(pdf.json().error.code, 'validation_failed');
});
