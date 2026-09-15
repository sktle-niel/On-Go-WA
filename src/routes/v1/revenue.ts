import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { currentAuth, MOBILE_ROLES, requireAuth } from '../../auth/guard.js';
import { legacyPaymentReportsEnabled } from '../../config/env.js';
import { errorResponses, NoContent } from '../../schemas/common.js';
import { CompletedPaymentReport, PlatformRevenueSummary } from '../../schemas/revenue.js';
import { LEGACY_REPORTS_PER_DAY, reportCompletedPayment, revenueSummary } from '../../services/revenue.service.js';
import { clientIpHash } from '../../utils/ip.js';

export const revenueRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const legacyReports = legacyPaymentReportsEnabled(app.config);

  app.post(
    '/payments',
    {
      preHandler: [requireAuth({ roles: MOBILE_ROLES })],
      schema: {
        tags: ['Revenue'],
        summary: 'Report a completed client payment',
        description:
          'PlatformRevenueApi.reportCompletedPayment. For a job the server holds this books nothing: ' +
          'revenue is booked when the client pays (`POST /service-requests/:id/pay`), so it answers 204 ' +
          'for a paid job the caller took part in and 404 otherwise. For a job the server does not hold, ' +
          'from a mobile build that still settles jobs on the device, and only while ' +
          '`LEGACY_PAYMENT_REPORTS` is on: the client who paid books it once per `requestId`, with the ' +
          'priority fee its urgency carries (normal 0, urgent 50, emergency 100), a `paidAt` from the ' +
          `last 7 days, and at most ${LEGACY_REPORTS_PER_DAY} reports a day (429 beyond).`,
        security: [{ bearerAuth: [] }],
        body: CompletedPaymentReport,
        response: { 204: NoContent, ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      await reportCompletedPayment(app.db, currentAuth(request), request.body, {
        legacyReports,
        meta: { ipHash: clientIpHash(request), requestId: request.id },
      });
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/revenue/summary',
    {
      preHandler: [requireAuth({ roles: ['admin'] })],
      schema: {
        tags: ['Revenue'],
        summary: 'Platform revenue by month and urgency',
        description:
          'PlatformRevenueApi.fetchSummary. Admin only. Months are bucketed in REVENUE_TIMEZONE. Counts ' +
          'server-settled payments and, during the compatibility window, device-reported ones.',
        security: [{ bearerAuth: [] }],
        response: { 200: PlatformRevenueSummary, ...errorResponses(401, 403) },
      },
    },
    async () => revenueSummary(app.db, app.config.REVENUE_TIMEZONE),
  );
};
