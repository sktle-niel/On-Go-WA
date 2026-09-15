import type { AppConfig } from '../config/env.js';
import { createDiskStorage } from './disk.js';
import { createGcsStorage } from './gcs.js';
import { newUuid, safeEqual, sha256 } from '../utils/crypto.js';
import { createHmac } from 'node:crypto';

/**
 * Object storage: where uploaded files live, and how a caller is handed a URL
 * to one.
 *
 * The interface is small on purpose so a disk implementation can back it in
 * development and tests while a cloud implementation backs it in a deployment,
 * and the routes and services never learn which. `disk` writes to the local
 * filesystem; `gcs` keeps files in a private Cloud Storage bucket (gcs.ts).
 * Either way the API serves the bytes itself, through the links below, so a
 * bucket is never exposed to a client.
 *
 * Two url shapes:
 *   - `signedUrl` is for PRIVATE files (credential documents). It carries an
 *     expiry and an HMAC signature, so the link works for a while and cannot be
 *     forged or altered. The files route verifies it.
 *   - `publicUrl` is for files that are meant to be public (the Sign In
 *     background the app paints before anyone signs in). Keys under the
 *     `public/` prefix are served without a signature.
 */

export type FileKind = 'document' | 'background' | 'chat';

/** Declared content-type is never trusted; the bytes decide. */
interface Detector {
  type: string;
  ext: string;
  matches: (buf: Buffer) => boolean;
}

const DETECTORS: Detector[] = [
  { type: 'image/jpeg', ext: 'jpg', matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    ext: 'png',
    matches: (b) =>
      b.length > 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    type: 'image/webp',
    ext: 'webp',
    matches: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  { type: 'application/pdf', ext: 'pdf', matches: (b) => b.length > 4 && b.toString('ascii', 0, 5) === '%PDF-' },
];

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];

/** The real content-type from the leading bytes, if it is in `allowed`. */
export function sniffContentType(buffer: Buffer, allowed: readonly string[]): { type: string; ext: string } | null {
  const hit = DETECTORS.find((d) => d.matches(buffer));
  if (!hit || !allowed.includes(hit.type)) return null;
  return { type: hit.type, ext: hit.ext };
}

function extToType(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return DETECTORS.find((d) => d.ext === ext)?.type ?? 'application/octet-stream';
}

/** Keys we generate: a safe charset, no traversal. Anything else is rejected. */
const SAFE_KEY = /^(public\/)?[a-z0-9]+(?:\/[a-z0-9]+)*\/[0-9a-f-]{36}\.[a-z0-9]+$/;

export function isSafeKey(key: string): boolean {
  return !key.includes('..') && SAFE_KEY.test(key);
}

export function isPublicKey(key: string): boolean {
  return key.startsWith('public/');
}

export interface PutResult {
  key: string;
  sha256: Buffer;
  bytes: number;
}

export interface Storage {
  /** Stores bytes under a freshly generated key for the kind. */
  put(input: { kind: FileKind; ext: string; body: Buffer }): Promise<PutResult>;
  delete(key: string): Promise<void>;
  /** Bytes + content-type for the serving route, or null when absent. */
  read(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  /** A time-limited, signed URL for a private file. */
  signedUrl(key: string, ttlSeconds: number): string;
  /** A stable URL for a public (`public/`) file. */
  publicUrl(key: string): string;
}

/** HMAC over key+expiry, so a private URL cannot be forged or extended. */
export function signKey(secret: string, key: string, exp: number): string {
  return createHmac('sha256', secret).update(`${key}:${exp}`).digest('base64url');
}

export function verifyKeySignature(secret: string, key: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = signKey(secret, key, exp);
  return safeEqual(Buffer.from(expected), Buffer.from(sig));
}

/** Base for the URLs handed to clients: absolute when PUBLIC_BASE_URL is set,
 *  otherwise a root-relative path the client resolves against its API base. */
export function urlBase(config: AppConfig): string {
  return config.PUBLIC_BASE_URL ? config.PUBLIC_BASE_URL.replace(/\/$/, '') : '';
}

/** A fresh key for a file of `kind`: a uuid under the kind's prefix. Keys are
 *  always made here, never taken from a client. */
export function keyFor(kind: FileKind, ext: string): string {
  const prefix = kind === 'background' ? 'public/background' : kind === 'chat' ? 'chat' : 'documents';
  return `${prefix}/${newUuid()}.${ext}`;
}

/** The links every driver hands out. The bytes live wherever the driver keeps
 *  them; `GET /api/v1/files/*` serves them after checking the link. */
export function apiFileUrls(config: AppConfig): Pick<Storage, 'signedUrl' | 'publicUrl'> {
  const base = urlBase(config);
  return {
    signedUrl(key: string, ttlSeconds: number): string {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      const sig = signKey(config.JWT_SIGNING_KEY, key, exp);
      return `${base}/api/v1/files/${key}?exp=${exp}&sig=${sig}`;
    },
    publicUrl(key: string): string {
      if (!isPublicKey(key)) throw new Error('publicUrl called for a non-public key');
      return `${base}/api/v1/files/${key}`;
    },
  };
}

export { extToType, sha256 };

export function createStorage(config: AppConfig): Storage {
  switch (config.STORAGE_DRIVER) {
    case 'gcs':
      // Config validation guarantees the bucket whenever this driver is chosen.
      return createGcsStorage(config, { bucket: config.GCS_BUCKET ?? '' });
    case 'disk':
    default:
      return createDiskStorage(config);
  }
}
