import type { FetchLike } from '../../src/storage/gcs.js';

/**
 * Stands in for the two Google endpoints the gcs storage driver calls: the
 * metadata server's access token and the Cloud Storage JSON API, with objects
 * kept in a Map. It answers the way Google does for the calls the driver makes
 * (401 without a bearer token, 404 for a missing object, 412 when a create-only
 * upload finds an object), and records every call so tests can check its shape.
 */
export interface FakeCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

function reply(status: number, body: Buffer | string = '') {
  const bytes = Buffer.from(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    async json(): Promise<unknown> {
      return JSON.parse(bytes.toString('utf8'));
    },
    async text(): Promise<string> {
      return bytes.toString('utf8');
    },
  };
}

export function fakeGoogle(bucket: string, options: { tokenTtlSeconds?: number; storageStatus?: number } = {}) {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const calls: FakeCall[] = [];
  let tokensIssued = 0;

  const fetch: FetchLike = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? Buffer.from(init.body) : undefined });

    if (url.hostname === 'metadata.google.internal') {
      if (init.headers['Metadata-Flavor'] !== 'Google') return reply(403);
      tokensIssued += 1;
      return reply(
        200,
        JSON.stringify({ access_token: `fake-token-${tokensIssued}`, expires_in: options.tokenTtlSeconds ?? 3599, token_type: 'Bearer' }),
      );
    }

    if (url.hostname !== 'storage.googleapis.com') return reply(404);
    if (!/^Bearer fake-token-\d+$/.test(init.headers.Authorization ?? '')) return reply(401);
    if (options.storageStatus) return reply(options.storageStatus, '{"error":{"message":"backend error"}}');

    if (init.method === 'POST' && url.pathname === `/upload/storage/v1/b/${bucket}/o`) {
      if (url.searchParams.get('uploadType') !== 'media') return reply(400);
      const name = url.searchParams.get('name') ?? '';
      if (url.searchParams.get('ifGenerationMatch') === '0' && objects.has(name)) return reply(412);
      objects.set(name, { body: Buffer.from(init.body ?? new Uint8Array()), contentType: init.headers['Content-Type'] ?? '' });
      return reply(200, JSON.stringify({ bucket, name }));
    }

    const prefix = `/storage/v1/b/${bucket}/o/`;
    if (url.pathname.startsWith(prefix)) {
      const name = decodeURIComponent(url.pathname.slice(prefix.length));
      if (init.method === 'GET' && url.searchParams.get('alt') === 'media') {
        const object = objects.get(name);
        return object ? reply(200, object.body) : reply(404);
      }
      if (init.method === 'DELETE') return objects.delete(name) ? reply(204) : reply(404);
    }
    return reply(400);
  };

  return { fetch, objects, calls, tokensIssued: () => tokensIssued };
}
