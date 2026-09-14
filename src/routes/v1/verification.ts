import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { CONSOLE_ROLES, currentAuth, requireAuth } from '../../auth/guard.js';
import { DOCUMENT_TYPES } from '../../storage/storage.js';
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
  addVerificationDocument,
  decideVerification,
  findVerificationRequest,
  listModerationActivity,
  listVerificationRequests,
  submitVerification,
  type CredentialKindName,
  type DecisionMeta,
  type DocumentContext,
} from '../../services/verification.service.js';
import { clientIp, clientIpHash } from '../../utils/ip.js';
import { consumeUpload } from '../../utils/uploads.js';

const CREDENTIAL_KINDS: readonly CredentialKindName[] = ['mechanic_id', 'document', 'certification'];

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
  const docs = (): DocumentContext => ({ storage: app.storage, urlTtlSeconds: app.config.FILE_URL_TTL_SECONDS });

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
      listVerificationRequests(app.db, docs(), {
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
          'account (409 on a second). Documents are attached with the documents route below.',
        security: [{ bearerAuth: [] }],
        body: SubmitVerificationBody,
        response: { 201: AccountVerificationRequest, ...errorResponses(400, 401, 403, 409) },
      },
    },
    async (request, reply) => {
      const dto = await submitVerification(app.db, app.events, docs(), currentAuth(request), request.body);
      return reply.code(201).send(dto);
    },
  );

  app.post(
    '/verification-requests/:id/documents',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] })],
      schema: {
        tags: ['Verification'],
        summary: 'Attach a document to a verification request',
        description:
          'Addition (not in on_go_shared). multipart/form-data: one `file` part (JPEG/PNG/WebP/PDF, ' +
          '≤ MAX_DOCUMENT_BYTES) plus optional `kind` (mechanic_id | document | certification) and ' +
          '`label` fields, sent before the file. Only the owning mechanic, only while pending. ' +
          'Returns the updated request with a signed `uri` for each document.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        consumes: ['multipart/form-data'],
        response: { 201: AccountVerificationRequest, ...errorResponses(400, 401, 403, 404, 409, 413) },
      },
    },
    async (request, reply) => {
      const upload = await consumeUpload(request, { maxBytes: app.config.MAX_DOCUMENT_BYTES, allowed: DOCUMENT_TYPES });
      const rawKind = upload.fields.kind as CredentialKindName | undefined;
      const kind: CredentialKindName = rawKind && CREDENTIAL_KINDS.includes(rawKind) ? rawKind : 'document';
      const label = (upload.fields.label ?? '').slice(0, 255);
      const dto = await addVerificationDocument(app.db, app.events, docs(), currentAuth(request), request.params.id, {
        body: upload.body,
        contentType: upload.contentType,
        ext: upload.ext,
        fileName: upload.fileName,
        kind,
        label,
      });
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
    async (request) => findVerificationRequest(app.db, docs(), currentAuth(request), request.params.id),
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
        docs(),
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
