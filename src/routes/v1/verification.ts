import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { CONSOLE_ROLES, currentAuth, requireAuth } from '../../auth/guard.js';
import { errorResponses, IdParams } from '../../schemas/common.js';
import {
  AccountVerificationRequest,
  ListActivityQuery,
  ListRequestsQuery,
  ModerationActivity,
  ModerationDecisionBody,
  SubmitVerificationBody,
} from '../../schemas/verification.js';
import {
  decideVerification,
  findVerificationRequest,
  listModerationActivity,
  listVerificationRequests,
  submitVerification,
  type DecisionMeta,
} from '../../services/verification.service.js';
import { clientIp, clientIpHash } from '../../utils/ip.js';

/**
 * AccountVerificationApi — the mobile → console → mobile round trip.
 *
 * The actor of every decision is the token holder; `actorName` / `actorId` in
 * the body are accepted for wire compatibility and ignored. Each action needs
 * its matching moderator permission, checked in the service; admins hold all.
 */
export const verificationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const meta = (request: FastifyRequest): DecisionMeta => ({
    ip: clientIp(request),
    ipHash: clientIpHash(request),
    requestId: request.id,
  });

  app.get(
    '/verification-requests',
    {
      preHandler: [requireAuth({ roles: CONSOLE_ROLES })],
      schema: {
        tags: ['Verification'],
        summary: 'List verification requests',
        description: 'AccountVerificationApi.listRequests. Console roles only. Newest first.',
        security: [{ bearerAuth: [] }],
        querystring: ListRequestsQuery,
        response: { 200: Type.Array(AccountVerificationRequest), ...errorResponses(401, 403) },
      },
    },
    async (request) =>
      listVerificationRequests(app.db, {
        status: request.query.status,
        escalatedOnly: request.query.escalatedOnly,
        search: request.query.search,
      }),
  );

  app.post(
    '/verification-requests',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] })],
      schema: {
        tags: ['Verification'],
        summary: 'File a verification request',
        description:
          'AccountVerificationApi.submit. Filed by the mechanic. One request may be pending per ' +
          'account (409 on a second). Documents are attached in Step 7; the names are carried now.',
        security: [{ bearerAuth: [] }],
        body: SubmitVerificationBody,
        response: { 201: AccountVerificationRequest, ...errorResponses(400, 401, 403, 409) },
      },
    },
    async (request, reply) => {
      const dto = await submitVerification(app.db, app.events, currentAuth(request), request.body, meta(request));
      return reply.code(201).send(dto);
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
          'AccountVerificationApi.findRequest. A mechanic sees only their own (else 404); console ' +
          'roles see any. Changes stream as `verification_request.updated`.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: AccountVerificationRequest, ...errorResponses(401, 404) },
      },
    },
    async (request) => findVerificationRequest(app.db, currentAuth(request), request.params.id),
  );

  app.post(
    '/verification-requests/:id/decision',
    {
      preHandler: [requireAuth({ roles: CONSOLE_ROLES })],
      schema: {
        tags: ['Verification'],
        summary: 'Approve, reject or escalate',
        description:
          'AccountVerificationApi.decide. The actor is the token holder, never the body. Each action ' +
          'needs the matching permission (approve / reject / escalate); admins hold all three. ' +
          'Escalation keeps the request pending but flags it for an admin.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: ModerationDecisionBody,
        response: { 200: AccountVerificationRequest, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) =>
      decideVerification(
        app.db,
        app.events,
        currentAuth(request),
        request.params.id,
        { action: request.body.action, reason: request.body.reason },
        meta(request),
      ),
  );

  app.get(
    '/moderation/activity',
    {
      preHandler: [requireAuth({ roles: CONSOLE_ROLES })],
      schema: {
        tags: ['Verification'],
        summary: 'Recent moderation activity',
        description: 'AccountVerificationApi.listActivity. Newest first.',
        security: [{ bearerAuth: [] }],
        querystring: ListActivityQuery,
        response: { 200: Type.Array(ModerationActivity), ...errorResponses(401, 403) },
      },
    },
    async (request) => listModerationActivity(app.db, request.query.limit ?? 50),
  );
};
