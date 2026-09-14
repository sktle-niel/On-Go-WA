import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { CONSOLE_ROLES, currentAuth, requireAuth, requirePermission } from '../../auth/guard.js';
import { PlatformAppearance } from '../../schemas/appearance.js';
import { errorResponses } from '../../schemas/common.js';
import { IMAGE_TYPES } from '../../storage/storage.js';
import { consumeUpload } from '../../utils/uploads.js';

/**
 * PlatformAppearanceApi — the Sign In background the console publishes and the
 * mobile app paints. Reading is public (the app paints it before sign-in);
 * publishing needs the canChangeBackground permission. The image is stored
 * under the `public/` prefix and served without a signature, because it is
 * shown before anyone has a token.
 */
const PLATFORM_APPEARANCE_UPDATED = 'platform_appearance.updated';

interface AppearanceRow {
  authBackgroundUrl: string | null;
  updatedAt: Date | null;
}

export const appearanceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const publisher = [requireAuth({ roles: CONSOLE_ROLES }), requirePermission('canChangeBackground')];

  const currentUrl = () =>
    app.db.queryOne<AppearanceRow>(
      `SELECT auth_background_url AS "authBackgroundUrl", updated_at AS "updatedAt" FROM platform_appearance WHERE id = 1`,
    );

  const toDto = (row: AppearanceRow | null) => ({
    authBackgroundUrl: row?.authBackgroundUrl ?? null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  });

  async function publish(dto: { authBackgroundUrl: string | null; updatedAt: string | null }): Promise<void> {
    // Public: every connected client may repaint. No audience restriction.
    await app.events.publish({ name: PLATFORM_APPEARANCE_UPDATED, data: dto });
  }

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
    async () => toDto(await currentUrl()),
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
          '(JPEG/PNG/WebP, ≤ MAX_BACKGROUND_BYTES). Returns the public URL and publishes ' +
          '`platform_appearance.updated`.',
        security: [{ bearerAuth: [] }],
        consumes: ['multipart/form-data'],
        response: { 200: PlatformAppearance, ...errorResponses(400, 401, 403, 413) },
      },
    },
    async (request: FastifyRequest) => {
      const auth = currentAuth(request);
      const upload = await consumeUpload(request, { maxBytes: app.config.MAX_BACKGROUND_BYTES, allowed: IMAGE_TYPES });
      const stored = await app.storage.put({ kind: 'background', ext: upload.ext, body: upload.body });
      const url = app.storage.publicUrl(stored.key);

      const previous = await app.db.queryOne<{ key: string | null }>(
        `SELECT auth_background_key AS key FROM platform_appearance WHERE id = 1`,
      );
      const row = await app.db.queryOne<AppearanceRow>(
        `UPDATE platform_appearance
            SET auth_background_key = $1, auth_background_url = $2, auth_background_type = $3,
                updated_at = now(), updated_by = $4
          WHERE id = 1
          RETURNING auth_background_url AS "authBackgroundUrl", updated_at AS "updatedAt"`,
        [stored.key, url, upload.contentType, auth.userId],
      );
      if (previous?.key && previous.key !== stored.key) await app.storage.delete(previous.key);

      const dto = toDto(row);
      await publish(dto);
      return dto;
    },
  );

  app.delete(
    '/platform/appearance',
    {
      preHandler: publisher,
      schema: {
        tags: ['Platform'],
        summary: 'Remove the Sign In background',
        description: 'PlatformAppearanceApi.clearBackground. Publishes `platform_appearance.updated`.',
        security: [{ bearerAuth: [] }],
        response: { 200: PlatformAppearance, ...errorResponses(401, 403) },
      },
    },
    async (request: FastifyRequest) => {
      const auth = currentAuth(request);
      const previous = await app.db.queryOne<{ key: string | null }>(
        `SELECT auth_background_key AS key FROM platform_appearance WHERE id = 1`,
      );
      const row = await app.db.queryOne<AppearanceRow>(
        `UPDATE platform_appearance
            SET auth_background_key = NULL, auth_background_url = NULL, auth_background_type = NULL,
                updated_at = now(), updated_by = $1
          WHERE id = 1
          RETURNING auth_background_url AS "authBackgroundUrl", updated_at AS "updatedAt"`,
        [auth.userId],
      );
      if (previous?.key) await app.storage.delete(previous.key);

      const dto = toDto(row);
      await publish(dto);
      return dto;
    },
  );
};
