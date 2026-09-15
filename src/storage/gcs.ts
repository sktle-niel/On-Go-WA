import type { AppConfig } from '../config/env.js';
import { sha256 } from '../utils/crypto.js';
import { apiFileUrls, extToType, isSafeKey, keyFor, type FileKind, type PutResult, type Storage } from './storage.js';

/**
 * Files in a private Google Cloud Storage bucket.
 *
 * Talks to the Cloud Storage JSON API directly, with the OAuth token of the
 * service account the process runs as, which Cloud Run's metadata server hands
 * out. No client library and no key file: nothing to leak and nothing to
 * rotate. The service account needs object read, create and delete on this one
 * bucket (roles/storage.objectUser) and nothing else.
 *
 * The bucket is never exposed. Clients get the API's own links (signed for
 * private files), and `GET /api/v1/files/*` reads the bytes from here. The
 * content type served comes from the key's extension, which the upload chose
 * from the file's bytes, never from object metadata.
 */

/** The slice of `fetch` the driver uses, so tests can stand in for Google. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GcsStorageOptions {
  bucket: string;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Returns a bearer token. Defaults to the runtime service account's token from the metadata server. */
  accessToken?: () => Promise<string>;
  /** Per request, so a stalled call fails instead of holding an upload open. */
  timeoutMs?: number;
}

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const STORAGE_API = 'https://storage.googleapis.com';

/**
 * The runtime service account's access token, from the metadata server. It is
 * kept until a minute before it expires, and fetched once even when several
 * calls ask for it at the same moment.
 */
export function metadataAccessToken(fetchImpl: FetchLike, timeoutMs = 5_000): () => Promise<string> {
  let cached: { value: string; renewAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  const fetchToken = async (): Promise<string> => {
    const res = await fetchImpl(METADATA_TOKEN_URL, {
      method: 'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`storage: the metadata server refused a token (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new Error('storage: the metadata server answered without a token');
    }
    cached = { value: body.access_token, renewAt: Date.now() + Math.max(0, body.expires_in - 60) * 1000 };
    return body.access_token;
  };

  return async () => {
    if (cached && Date.now() < cached.renewAt) return cached.value;
    inFlight ??= fetchToken().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export function createGcsStorage(config: AppConfig, options: GcsStorageOptions): Storage {
  if (!options.bucket) throw new Error('storage: GCS_BUCKET is required for the gcs driver');
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const accessToken = options.accessToken ?? metadataAccessToken(fetchImpl);
  const bucket = encodeURIComponent(options.bucket);
  const urls = apiFileUrls(config);

  const objectUrl = (key: string): string => {
    if (!isSafeKey(key)) throw new Error('unsafe storage key');
    return `${STORAGE_API}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`;
  };

  const send = async (url: string, method: string, headers: Record<string, string> = {}, body?: Uint8Array) =>
    fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

  /** Reads and drops a body the driver does not need, so the connection is released. */
  const drain = async (res: { text(): Promise<string> }): Promise<void> => {
    await res.text().catch(() => '');
  };

  return {
    async put(input: { kind: FileKind; ext: string; body: Buffer }): Promise<PutResult> {
      const key = keyFor(input.kind, input.ext);
      if (!isSafeKey(key)) throw new Error('unsafe storage key');
      // ifGenerationMatch=0: create only, never overwrite an existing object.
      const url =
        `${STORAGE_API}/upload/storage/v1/b/${bucket}/o` +
        `?uploadType=media&name=${encodeURIComponent(key)}&ifGenerationMatch=0`;
      const res = await send(url, 'POST', { 'Content-Type': extToType(key) }, input.body);
      await drain(res);
      if (!res.ok) throw new Error(`storage: upload failed (HTTP ${res.status})`);
      return { key, sha256: sha256(input.body), bytes: input.body.byteLength };
    },

    async delete(key: string): Promise<void> {
      const res = await send(objectUrl(key), 'DELETE');
      await drain(res);
      if (!res.ok && res.status !== 404) throw new Error(`storage: delete failed (HTTP ${res.status})`);
    },

    async read(key: string): Promise<{ body: Buffer; contentType: string } | null> {
      const res = await send(`${objectUrl(key)}?alt=media`, 'GET');
      if (res.status === 404) {
        await drain(res);
        return null;
      }
      if (!res.ok) {
        await drain(res);
        throw new Error(`storage: read failed (HTTP ${res.status})`);
      }
      return { body: Buffer.from(await res.arrayBuffer()), contentType: extToType(key) };
    },

    signedUrl: urls.signedUrl,
    publicUrl: urls.publicUrl,
  };
}
