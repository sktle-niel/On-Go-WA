import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { currentAuth, requireAuth } from '../../auth/guard.js';
import { errorResponses, IdParams, Uuid } from '../../schemas/common.js';
import {
  AcceptEmergencyBody,
  AgreedAmountBody,
  CancelServiceRequestBody,
  CreateServiceRequestBody,
  ListRequestsQuery,
  MechanicCancelBody,
  MechanicQuote,
  PayBody,
  ServiceRequest,
  SubmitQuoteBody,
} from '../../schemas/jobs.js';
import {
  acceptEmergency,
  acceptQuote,
  advanceJobStatus,
  cancelServiceRequest,
  createServiceRequest,
  expireOverdueJobs,
  getServiceRequest,
  listQuotes,
  listServiceRequests,
  mechanicCancelJob,
  payForJob,
  rejectQuote,
  reopenServiceRequest,
  setAgreedAmount,
  submitQuote,
  withdrawQuote,
  type StatusStep,
} from '../../services/jobs.service.js';
import { clientIpHash } from '../../utils/ip.js';

const QuoteIdParams = Type.Object({ id: Uuid, quoteId: Uuid });

/**
 * The jobs domain — slice 1: service requests (booking). Not in on_go_shared
 * yet; see PROJECT.md → Contract gaps for the additions to coordinate.
 *
 * A client books a request; mechanics browse the open pool (`?scope=open`).
 * Acceptance, quotes, the status machine, payment and reviews are later slices.
 */
export const jobRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Every jobs route lets overdue jobs lapse before it runs, after the auth
  // guard, so each call sees jobs as they stand now (see expireOverdueJobs).
  const expireDue: preHandlerAsyncHookHandler = async () => {
    await expireOverdueJobs(app.db, app.events);
  };

  app.post(
    '/service-requests',
    {
      preHandler: [requireAuth({ roles: ['client'] }), expireDue],
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
      preHandler: [requireAuth(), expireDue],
      schema: {
        tags: ['Jobs'],
        summary: 'List service requests',
        description:
          'Addition. `?scope=open` is the pool of pending jobs, for mechanics and console roles; a ' +
          'client gets 403. `?scope=mine` (default) is the caller\'s own requests, or, for a mechanic, ' +
          'the jobs assigned to them.',
        security: [{ bearerAuth: [] }],
        querystring: ListRequestsQuery,
        response: { 200: Type.Array(ServiceRequest), ...errorResponses(401, 403) },
      },
    },
    async (request) =>
      listServiceRequests(
        app.db,
        currentAuth(request),
        { scope: request.query.scope, urgency: request.query.urgency },
        { ipHash: clientIpHash(request), requestId: request.id },
      ),
  );

  app.get(
    '/service-requests/:id',
    {
      preHandler: [requireAuth(), expireDue],
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
      preHandler: [requireAuth({ roles: ['client'] }), expireDue],
      schema: {
        tags: ['Jobs'],
        summary: 'Cancel a service request',
        description:
          'Addition, the app\'s "Delete". The client closes their own request as `cancelled`: a pending ' +
          'request always; a matched one once the mechanic\'s quoted arrival time has passed or they have ' +
          'arrived, and before work starts (409 otherwise, with `details.cancellableAt` while the ETA lock ' +
          'holds). A completed or already-cancelled request is 409.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: CancelServiceRequestBody,
        response: { 200: ServiceRequest, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) =>
      cancelServiceRequest(app.db, app.events, currentAuth(request), request.params.id, request.body.reason ?? null),
  );

  app.post(
    '/service-requests/:id/reopen',
    {
      preHandler: [requireAuth({ roles: ['client'] }), expireDue],
      schema: {
        tags: ['Jobs'],
        summary: 'Put a matched job back in the open pool',
        description:
          'Addition, the app\'s "Revert to Pending". The client releases the mechanic once their quoted ' +
          'arrival time has passed or they have arrived, and before work starts (409 otherwise, with ' +
          '`details.cancellableAt` while the ETA lock holds). The mechanic\'s quote stays live; an ' +
          'Emergency accept record is withdrawn. Mechanics hear the job is open again.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: ServiceRequest, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => reopenServiceRequest(app.db, app.events, currentAuth(request), request.params.id),
  );

  app.post(
    '/service-requests/:id/mechanic-cancel',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] }), expireDue],
      schema: {
        tags: ['Jobs'],
        summary: 'Cancel a job you accepted',
        description:
          'Addition. The assigned mechanic backs out of a matched Normal or Urgent job before taking any ' +
          'progress step, with a reason the client is shown. The job returns to the open pool and the ' +
          'mechanic\'s quote is withdrawn; they may quote again. An Emergency, or a job already under way, ' +
          'answers 409.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: MechanicCancelBody,
        response: { 200: ServiceRequest, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) =>
      mechanicCancelJob(app.db, app.events, currentAuth(request), request.params.id, request.body.reason),
  );

  // ── Quotes (Normal / Urgent requests; Emergency is accepted directly) ──────

  app.post(
    '/service-requests/:id/quotes',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] }), expireDue],
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
      preHandler: [requireAuth(), expireDue],
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
      preHandler: [requireAuth({ roles: ['mechanic'] }), expireDue],
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
      preHandler: [requireAuth({ roles: ['client'] }), expireDue],
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
      preHandler: [requireAuth({ roles: ['client'] }), expireDue],
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
      preHandler: [requireAuth({ roles: ['mechanic'] }), expireDue],
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

  // ── Service-status machine (the assigned mechanic advances a matched job) ──

  const STEPS: Array<{ path: string; step: StatusStep; summary: string }> = [
    { path: 'navigating', step: 'navigating', summary: 'Start navigating to the job' },
    { path: 'en-route', step: 'en_route', summary: 'Mark en route' },
    { path: 'arrived', step: 'arrived', summary: 'Mark arrived' },
    { path: 'start-work', step: 'work_started', summary: 'Start work' },
    { path: 'complete-service', step: 'service_completed', summary: 'Mark the service complete' },
  ];

  for (const { path, step, summary } of STEPS) {
    app.post(
      `/service-requests/:id/${path}`,
      {
        preHandler: [requireAuth({ roles: ['mechanic'] }), expireDue],
        schema: {
          tags: ['Jobs'],
          summary,
          description: `Addition. The assigned mechanic advances a matched job (${step}). Idempotent.`,
          security: [{ bearerAuth: [] }],
          params: IdParams,
          response: { 200: ServiceRequest, ...errorResponses(401, 403, 404, 409) },
        },
      },
      async (request) => advanceJobStatus(app.db, app.events, currentAuth(request), request.params.id, step),
    );
  }

  // ── Payment (the client pays; the job closes) ─────────────────────────────

  app.put(
    '/service-requests/:id/agreed-amount',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] }), expireDue],
      schema: {
        tags: ['Jobs'],
        summary: 'Set the agreed amount on an emergency',
        description:
          'Addition. EMERGENCY ONLY: the assigned mechanic records the price agreed with the client in ' +
          'person, and may correct it until the job is paid. Normal and Urgent jobs are paid their ' +
          'accepted quote, so they answer 409 here.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: AgreedAmountBody,
        response: { 200: ServiceRequest, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) =>
      setAgreedAmount(app.db, app.events, currentAuth(request), request.params.id, request.body.amount),
  );

  app.post(
    '/service-requests/:id/pay',
    {
      preHandler: [requireAuth({ roles: ['client'] }), expireDue],
      schema: {
        tags: ['Jobs'],
        summary: 'Pay for a finished job',
        description:
          'Addition. The request owner pays once the mechanic has marked the service complete, and the ' +
          'request becomes completed. The server settles every figure: the accepted quote price (or the ' +
          'agreed amount on an Emergency), the priority fee fixed on the request, and points from the ' +
          'policy. `payFeeWithPoints` spends points on the fee when the balance covers it; otherwise the ' +
          'fee is charged in pesos. Send `expectedAmount` to refuse a price that changed (409). ' +
          'Idempotent: paying a paid job returns it unchanged. Send a JSON body, `{}` at least.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: PayBody,
        response: { 200: ServiceRequest, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) => payForJob(app.db, app.events, currentAuth(request), request.params.id, request.body),
  );
};
