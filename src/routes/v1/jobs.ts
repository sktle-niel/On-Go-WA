import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import { currentAuth, requireAuth } from '../../auth/guard.js';
import { errorResponses, IdParams, Uuid } from '../../schemas/common.js';
import {
  AcceptEmergencyBody,
  CancelServiceRequestBody,
  CreateServiceRequestBody,
  ListRequestsQuery,
  MechanicQuote,
  ServiceRequest,
  SubmitQuoteBody,
} from '../../schemas/jobs.js';
import {
  acceptEmergency,
  acceptQuote,
  cancelServiceRequest,
  createServiceRequest,
  getServiceRequest,
  listQuotes,
  listServiceRequests,
  rejectQuote,
  submitQuote,
  withdrawQuote,
} from '../../services/jobs.service.js';

const QuoteIdParams = Type.Object({ id: Uuid, quoteId: Uuid });

/**
 * The jobs domain — slice 1: service requests (booking). Not in on_go_shared
 * yet; see PROJECT.md → Contract gaps for the additions to coordinate.
 *
 * A client books a request; mechanics browse the open pool (`?scope=open`).
 * Acceptance, quotes, the status machine, payment and reviews are later slices.
 */
export const jobRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/service-requests',
    {
      preHandler: [requireAuth({ roles: ['client'] })],
      schema: {
        tags: ['Jobs'],
        summary: 'Book a service request',
        description:
          'Addition. The client posts a request for help at a location. One active request per ' +
          'client at a time (409 on a second). The priority fee (surcharge) is set from the urgency.',
        security: [{ bearerAuth: [] }],
        body: CreateServiceRequestBody,
        response: { 201: ServiceRequest, ...errorResponses(400, 401, 403, 409) },
      },
    },
    async (request, reply) => {
      const dto = await createServiceRequest(app.db, app.events, currentAuth(request), request.body);
      return reply.code(201).send(dto);
    },
  );

  app.get(
    '/service-requests',
    {
      preHandler: [requireAuth()],
      schema: {
        tags: ['Jobs'],
        summary: 'List service requests',
        description:
          'Addition. `?scope=open` is the pool of pending jobs (for mechanics); `?scope=mine` ' +
          '(default) is the caller\'s own requests, or, for a mechanic, the jobs assigned to them.',
        security: [{ bearerAuth: [] }],
        querystring: ListRequestsQuery,
        response: { 200: Type.Array(ServiceRequest), ...errorResponses(401, 403) },
      },
    },
    async (request) =>
      listServiceRequests(app.db, currentAuth(request), {
        scope: request.query.scope,
        urgency: request.query.urgency,
      }),
  );

  app.get(
    '/service-requests/:id',
    {
      preHandler: [requireAuth()],
      schema: {
        tags: ['Jobs'],
        summary: 'One service request',
        description:
          'Addition. The client owner and the assigned mechanic see it; a mechanic also sees an ' +
          'open (pending) request; console roles see any. Otherwise 404.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: ServiceRequest, ...errorResponses(401, 404) },
      },
    },
    async (request) => getServiceRequest(app.db, currentAuth(request), request.params.id),
  );

  app.post(
    '/service-requests/:id/cancel',
    {
      preHandler: [requireAuth({ roles: ['client'] })],
      schema: {
        tags: ['Jobs'],
        summary: 'Cancel a service request',
        description:
          'Addition. The client cancels their own still-pending request. A matched job gains an ' +
          'ETA-lock rule with the acceptance slice; a completed or already-cancelled request is 409.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: CancelServiceRequestBody,
        response: { 200: ServiceRequest, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) =>
      cancelServiceRequest(app.db, app.events, currentAuth(request), request.params.id, request.body.reason ?? null),
  );

  // ── Quotes (Normal / Urgent requests; Emergency is accepted directly) ──────

  app.post(
    '/service-requests/:id/quotes',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] })],
      schema: {
        tags: ['Jobs'],
        summary: 'Send a quote',
        description:
          'Addition. An approved mechanic quotes a pending Normal/Urgent request: price and ETA in ' +
          'minutes. One live quote per mechanic per request; the ETA must fit the completion window; ' +
          'a mechanic the client rejected cannot re-quote; a withdrawn quote may be sent again.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: SubmitQuoteBody,
        response: { 201: MechanicQuote, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      const dto = await submitQuote(app.db, app.events, currentAuth(request), request.params.id, request.body);
      return reply.code(201).send(dto);
    },
  );

  app.get(
    '/service-requests/:id/quotes',
    {
      preHandler: [requireAuth()],
      schema: {
        tags: ['Jobs'],
        summary: 'List quotes on a request',
        description:
          'Addition. The client owner sees live offers; a mechanic sees their own quote; console sees all.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: Type.Array(MechanicQuote), ...errorResponses(401, 404) },
      },
    },
    async (request) => listQuotes(app.db, currentAuth(request), request.params.id),
  );

  app.post(
    '/service-requests/:id/quotes/withdraw',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] })],
      schema: {
        tags: ['Jobs'],
        summary: 'Withdraw your quote',
        description: 'Addition. The mechanic takes their own live, unaccepted quote back; they may quote again after.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: MechanicQuote, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => withdrawQuote(app.db, app.events, currentAuth(request), request.params.id),
  );

  app.post(
    '/service-requests/:id/quotes/:quoteId/reject',
    {
      preHandler: [requireAuth({ roles: ['client'] })],
      schema: {
        tags: ['Jobs'],
        summary: 'Reject a quote',
        description: 'Addition. The request owner turns a live quote down; that mechanic cannot re-quote the job.',
        security: [{ bearerAuth: [] }],
        params: QuoteIdParams,
        response: { 200: MechanicQuote, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => rejectQuote(app.db, app.events, currentAuth(request), request.params.id, request.params.quoteId),
  );

  // ── Accept (the atomic claim) ──────────────────────────────────────────────

  app.post(
    '/service-requests/:id/quotes/:quoteId/accept',
    {
      preHandler: [requireAuth({ roles: ['client'] })],
      schema: {
        tags: ['Jobs'],
        summary: 'Accept a quote',
        description:
          'Addition. The request owner accepts a live quote; the request becomes matched to that ' +
          'mechanic. Atomic: a second accept on the same request is refused (409).',
        security: [{ bearerAuth: [] }],
        params: QuoteIdParams,
        response: { 200: ServiceRequest, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => acceptQuote(app.db, app.events, currentAuth(request), request.params.id, request.params.quoteId),
  );

  app.post(
    '/service-requests/:id/accept',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] })],
      schema: {
        tags: ['Jobs'],
        summary: 'Accept an emergency',
        description:
          'Addition. An approved mechanic takes an open Emergency directly (first-come). One active ' +
          'emergency per mechanic; the ETA must fit the 12-hour window. The price is agreed in person.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: AcceptEmergencyBody,
        response: { 200: ServiceRequest, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) => acceptEmergency(app.db, app.events, currentAuth(request), request.params.id, request.body),
  );
};
