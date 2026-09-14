import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import { requireAuth } from '../../auth/guard.js';
import { Permissions } from '../../schemas/auth.js';
import { errorResponses, IdParams, NoContent } from '../../schemas/common.js';
import {
  AuditEntry,
  CreateModeratorBody,
  ModeratorAccount,
  RemoveModeratorQuery,
  UpdateProfileBody,
} from '../../schemas/moderators.js';
import { notImplemented } from '../../utils/errors.js';

/**
 * ModeratorDirectoryApi — the roster and its audit trail. Admin only.
 *
 * Routes, guards and schemas are final; handlers answer 501 until the
 * moderator domain is implemented.
 */
export const moderatorRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const admin = [requireAuth({ roles: ['admin'] })];
  const pending = 'The moderator directory is being implemented.';

  app.get(
    '/moderators',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'List moderators',
        description: 'ModeratorDirectoryApi.listModerators.',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Array(ModeratorAccount), ...errorResponses(401, 403, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );

  app.post(
    '/moderators',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'Create a moderator',
        description: 'ModeratorDirectoryApi.createModerator. The temporary password is hashed and never stored in clear.',
        security: [{ bearerAuth: [] }],
        body: CreateModeratorBody,
        response: { 201: ModeratorAccount, ...errorResponses(400, 401, 403, 409, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );

  app.delete(
    '/moderators/:id',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'Remove a moderator',
        description: 'ModeratorDirectoryApi.removeModerator. Deactivates the account and revokes its sessions.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        querystring: RemoveModeratorQuery,
        response: { 204: NoContent, ...errorResponses(401, 403, 404, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );

  app.put(
    '/moderators/:id/permissions',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'Replace a moderator’s permissions',
        description: 'ModeratorDirectoryApi.updatePermissions. Takes effect on the moderator’s next request.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: Permissions,
        response: { 200: ModeratorAccount, ...errorResponses(400, 401, 403, 404, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );

  app.patch(
    '/moderators/:id/profile',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'Update a moderator’s profile',
        description: 'ModeratorDirectoryApi.updateProfile.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: UpdateProfileBody,
        response: { 200: ModeratorAccount, ...errorResponses(400, 401, 403, 404, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );

  app.get(
    '/audit-log',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'The audit log',
        description: 'ModeratorDirectoryApi.listAuditLog. Roster changes and queue decisions, newest first.',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Array(AuditEntry), ...errorResponses(401, 403, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );
};
