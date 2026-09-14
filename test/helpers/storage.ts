import type { AppConfig } from '../../src/config/env.js';
import { newUuid, sha256 } from '../../src/utils/crypto.js';
import { extToType, isPublicKey, signKey, urlBase, type Storage } from '../../src/storage/storage.js';

/**
 * In-memory object storage for tests: the same key shapes and the same signed
 * and public URL logic as the disk driver, but bytes live in a Map, so a test
 * run writes nothing to disk and needs no cleanup.
 */
export function createMemoryStorage(config: AppConfig): Storage {
  const files = new Map<string, { body: Buffer; contentType: string }>();
  const base = urlBase(config);

  return {
    async put({ kind, ext, body }) {
      const prefix = kind === 'background' ? 'public/background' : 'documents';
      const key = `${prefix}/${newUuid()}.${ext}`;
      files.set(key, { body, contentType: extToType(key) });
      return { key, sha256: sha256(body), bytes: body.byteLength };
    },
    async delete(key) {
      files.delete(key);
    },
    async read(key) {
      return files.get(key) ?? null;
    },
    signedUrl(key, ttlSeconds) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      const sig = signKey(config.JWT_SIGNING_KEY, key, exp);
      return `${base}/api/v1/files/${key}?exp=${exp}&sig=${sig}`;
    },
    publicUrl(key) {
      if (!isPublicKey(key)) throw new Error('publicUrl called for a non-public key');
      return `${base}/api/v1/files/${key}`;
    },
  };
}
