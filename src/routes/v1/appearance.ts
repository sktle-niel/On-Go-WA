import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { CONSOLE_ROLES, requireAuth, requirePermission } from '../../auth/guard.js';
import { PlatformAppearance } from '../../schemas/appearance.js';
import { errorResponses } from '../../schemas/common.js';
import { notImplemented } from '../../utils/errors.js';

/**
 * PlatformAppearanceApi — the Sign In background the console publishes and
 * the mobile app paints. Reading is public (the app paints it before sign-in);
 * publishing needs the canChangeBackground permission and object storage,
 * which is why the write side is still 501.
 */
export const appearanceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const publisher = [requireAuth({ roles: CONSOLE_ROLES }), requirePermission('canChangeBackground')];

  app.get(
    '/platform/appearance',
    {
      schema: {
        tags: ['Platform'],
        summary: 'The published Sign In background',
        description: 'PlatformAppearanceApi.fetch. Public.',
        response: { 200: PlatformAppearance },
      },
    },
    async () => {
      const row = await app.db.queryOne<{ authBackgroundUrl: string | null; updatedAt: Date | null }>(
        `SELECT auth_background_url AS "authBackgroundUrl", updated_at AS "updatedAt"
           FROM platform_appearance WHERE id = 1`,
      );
      return {
        authBackgroundUrl: row?.authBackgroundUrl ?? null,
        updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      };
    },
  );

  app.put(
    '/platform/appearance',
    {
      preHandler: publisher,
      schema: {
        tags: ['Platform'],
        summary: 'Publish a new Sign In background',
        description:
          'PlatformAppearanceApi.publishBackground. multipart/form-data with one `file` part ' +
          '(JPEG/PNG/WebP, ≤ 5 MB). Stored in object storage; the public URL is returned.',
        security: [{ bearerAuth: [] }],
        consumes: ['multipart/form-data'],
        response: { 200: PlatformAppearance, ...errorResponses(400, 401, 403, 413, 501) },
      },
    },
    async () => {
      throw notImplemented('Background publishing needs object storage (S3) — next step.');
    },
  );

  app.delete(
    '/platform/appearance',
    {
      preHandler: publisher,
      schema: {
        tags: ['Platform'],
        summary: 'Remove the Sign In background',
        description: 'PlatformAppearanceApi.clearBackground.',
        security: [{ bearerAuth: [] }],
        response: { 200: PlatformAppearance, ...errorResponses(401, 403, 501) },
      },
    },
    async () => {
      throw notImplemented('Background publishing needs object storage (S3) — next step.');
    },
  );
};
