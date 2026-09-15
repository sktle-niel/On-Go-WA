import type { AppConfig } from '../../src/config/env.js';
import { sha256 } from '../../src/utils/crypto.js';
import { apiFileUrls, extToType, keyFor, type Storage } from '../../src/storage/storage.js';

/**
 * In-memory object storage for tests: the same key shapes and the same signed
 * and public URL logic as the disk driver, but bytes live in a Map, so a test
 * run writes nothing to disk and needs no cleanup.
 */
export function createMemoryStorage(config: AppConfig): Storage {
  const files = new Map<string, { body: Buffer; contentType: string }>();
  const urls = apiFileUrls(config);

  return {
    async put({ kind, ext, body }) {
      const key = keyFor(kind, ext);
      files.set(key, { body, contentType: extToType(key) });
      return { key, sha256: sha256(body), bytes: body.byteLength };
    },
    async delete(key) {
      files.delete(key);
    },
    async read(key) {
      return files.get(key) ?? null;
    },
    signedUrl: urls.signedUrl,
    publicUrl: urls.publicUrl,
  };
}
