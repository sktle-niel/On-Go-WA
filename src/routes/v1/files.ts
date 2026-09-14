import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { isPublicKey, isSafeKey, verifyKeySignature } from '../../storage/storage.js';
import { forbidden, notFound } from '../../utils/errors.js';

/**
 * Serves stored files. Public files (the Sign In background, under `public/`)
 * are served straight; everything else needs a valid, unexpired signature —
 * the one `Storage.signedUrl` mints. The key is validated before it touches the
 * store, and the store resolves it inside the upload directory, so a crafted
 * path cannot escape.
 *
 * Hidden from the OpenAPI document: it returns bytes, not a JSON schema.
 */
export const filesRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/files/*', { schema: { hide: true } }, async (request, reply) => {
    const key = (request.params as Record<string, string>)['*'] ?? '';
    if (!isSafeKey(key)) throw notFound('File not found.');

    if (!isPublicKey(key)) {
      const { exp, sig } = request.query as { exp?: string; sig?: string };
      const okay = typeof sig === 'string' && verifyKeySignature(app.config.JWT_SIGNING_KEY, key, Number(exp), sig);
      if (!okay) throw forbidden('This link has expired or is invalid.');
    }

    const file = await app.storage.read(key);
    if (!file) throw notFound('File not found.');

    void reply.header('Content-Type', file.contentType);
    void reply.header('Cache-Control', isPublicKey(key) ? 'public, max-age=300' : 'private, max-age=60');
    void reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(file.body);
  });
};
