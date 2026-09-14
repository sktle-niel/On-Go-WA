import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { currentAuth, requireAuth } from '../../auth/guard.js';
import { Permissions } from '../../schemas/auth.js';
import { errorResponses, IdParams, NoContent } from '../../schemas/common.js';
import {
  AuditEntry,
  CreateModeratorBody,
  ModeratorAccount,
  RemoveModeratorQuery,
  UpdateProfileBody,
} from '../../schemas/moderators.js';
import {
  createModerator,
  listAuditLog,
  listModerators,
  removeModerator,
  updateModeratorPermissions,
  updateModeratorProfile,
  type AdminActionMeta,
} from '../../services/moderators.service.js';
import { clientIp, clientIpHash } from '../../utils/ip.js';

/**
 * ModeratorDirectoryApi and the audit log — admin only.
 *
 * The audit log merges roster changes written here with the queue decisions
 * the verification service writes; both live in admin_audit_log.
 */
export const moderatorRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const admin = [requireAuth({ roles: ['admin'] })];
  const meta = (request: FastifyRequest): AdminActionMeta => ({
    ip: clientIp(request),
    ipHash: clientIpHash(request),
    requestId: request.id,
  });

  app.get(
    '/moderators',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'List moderators',
        description: 'ModeratorDirectoryApi.listModerators. Newest first, active and inactive.',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Array(ModeratorAccount), ...errorResponses(401, 403) },
      },
    },
    async () => listModerators(app.db),
  );

  app.post(
    '/moderators',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'Create a moderator',
        description:
          'ModeratorDirectoryApi.createModerator. The temporary password is hashed and never stored ' +
          'in clear. The new moderator signs in on the console with it.',
        security: [{ bearerAuth: [] }],
        body: CreateModeratorBody,
        response: { 201: ModeratorAccount, ...errorResponses(400, 401, 403, 409) },
      },
    },
    async (request, reply) => {
      const dto = await createModerator(
        app.db,
        app.events,
        currentAuth(request),
        {
          name: request.body.name,
          email: request.body.email,
          temporaryPassword: request.body.temporaryPassword,
          permissions: request.body.permissions,
        },
        meta(request),
      );
      return reply.code(201).send(dto);
    },
  );

  app.delete(
    '/moderators/:id',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'Remove a moderator',
        description:
          'ModeratorDirectoryApi.removeModerator. Deactivates the account and revokes its sessions, ' +
          'so access ends on the next request.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        querystring: RemoveModeratorQuery,
        response: { 204: NoContent, ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await removeModerator(app.db, app.events, currentAuth(request), request.params.id, request.query.reason ?? null, meta(request));
      return reply.code(204).send(null);
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
        response: { 200: ModeratorAccount, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) =>
      updateModeratorPermissions(app.db, app.events, currentAuth(request), request.params.id, request.body, meta(request)),
  );

  app.patch(
    '/moderators/:id/profile',
    {
      preHandler: admin,
      schema: {
        tags: ['Moderators'],
        summary: 'Update a moderator’s profile',
        description: 'ModeratorDirectoryApi.updateProfile. Name and/or photo; send `photoUrl: null` to clear it.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: UpdateProfileBody,
        response: { 200: ModeratorAccount, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) =>
      updateModeratorProfile(
        app.db,
        app.events,
        currentAuth(request),
        request.params.id,
        { name: request.body.name, photoUrl: request.body.photoUrl },
        meta(request),
      ),
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
        response: { 200: Type.Array(AuditEntry), ...errorResponses(401, 403) },
      },
    },
    async () => listAuditLog(app.db),
  );
};
