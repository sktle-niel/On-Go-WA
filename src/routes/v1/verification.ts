import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import { CONSOLE_ROLES, requireAuth } from '../../auth/guard.js';
import { errorResponses, IdParams } from '../../schemas/common.js';
import {
  AccountVerificationRequest,
  ListActivityQuery,
  ListRequestsQuery,
  ModerationActivity,
  ModerationDecisionBody,
  SubmitVerificationBody,
} from '../../schemas/verification.js';
import { notImplemented } from '../../utils/errors.js';

/**
 * AccountVerificationApi — the mobile → console → mobile round trip.
 *
 * The routes, guards and schemas are final; the handlers are the next piece
 * of work and answer 501 until then. Documented now so the front-end client
 * can be written against the real contract.
 */
export const verificationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const pending = 'Verification requests are being implemented.';

  app.get(
    '/verification-requests',
    {
      preHandler: [requireAuth({ roles: CONSOLE_ROLES })],
      schema: {
        tags: ['Verification'],
        summary: 'List verification requests',
        description: 'AccountVerificationApi.listRequests. Console roles only.',
        security: [{ bearerAuth: [] }],
        querystring: ListRequestsQuery,
        response: { 200: Type.Array(AccountVerificationRequest), ...errorResponses(401, 403, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );

  app.post(
    '/verification-requests',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] })],
      schema: {
        tags: ['Verification'],
        summary: 'File a verification request',
        description:
          'AccountVerificationApi.submit. Called by the mechanic after registration. ' +
          'Documents are uploaded separately (multipart) and attached by id.',
        security: [{ bearerAuth: [] }],
        body: SubmitVerificationBody,
        response: { 201: AccountVerificationRequest, ...errorResponses(400, 401, 403, 409, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );

  app.get(
    '/verification-requests/:id',
    {
      preHandler: [requireAuth()],
      schema: {
        tags: ['Verification'],
        summary: 'One verification request',
        description:
          'AccountVerificationApi.findRequest. A mechanic sees only their own; console roles see any. ' +
          'Changes stream on the event socket as `verification_request.updated`.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: AccountVerificationRequest, ...errorResponses(401, 404, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );

  app.post(
    '/verification-requests/:id/decision',
    {
      preHandler: [requireAuth({ roles: CONSOLE_ROLES })],
      schema: {
        tags: ['Verification'],
        summary: 'Approve, reject or escalate',
        description:
          'AccountVerificationApi.decide. The actor is the token holder, never the body. ' +
          'Each action needs the matching moderator permission; admins hold all three.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: ModerationDecisionBody,
        response: { 200: AccountVerificationRequest, ...errorResponses(400, 401, 403, 404, 409, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );

  app.get(
    '/moderation/activity',
    {
      preHandler: [requireAuth({ roles: CONSOLE_ROLES })],
      schema: {
        tags: ['Verification'],
        summary: 'Recent moderation activity',
        description: 'AccountVerificationApi.listActivity.',
        security: [{ bearerAuth: [] }],
        querystring: ListActivityQuery,
        response: { 200: Type.Array(ModerationActivity), ...errorResponses(401, 403, 501) },
      },
    },
    async () => {
      throw notImplemented(pending);
    },
  );
};
