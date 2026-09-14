import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { currentAuth, MOBILE_ROLES, requireAuth } from '../../auth/guard.js';
import { errorResponses, NoContent } from '../../schemas/common.js';
import { CompletedPaymentReport, PlatformRevenueSummary } from '../../schemas/revenue.js';
import { reportCompletedPayment, revenueSummary } from '../../services/revenue.service.js';

export const revenueRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/payments',
    {
      preHandler: [requireAuth({ roles: MOBILE_ROLES })],
      schema: {
        tags: ['Revenue'],
        summary: 'Report a completed client payment',
        description:
          'PlatformRevenueApi.reportCompletedPayment. Idempotent per requestId: reporting the ' +
          'same payment twice books it once. Only the mobile surface can call this.',
        security: [{ bearerAuth: [] }],
        body: CompletedPaymentReport,
        response: { 204: NoContent, ...errorResponses(400, 401, 403) },
      },
    },
    async (request, reply) => {
      await reportCompletedPayment(app.db, currentAuth(request), request.body);
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
        description: 'PlatformRevenueApi.fetchSummary. Admin only. Months are bucketed in REVENUE_TIMEZONE.',
        security: [{ bearerAuth: [] }],
        response: { 200: PlatformRevenueSummary, ...errorResponses(401, 403) },
      },
    },
    async () => revenueSummary(app.db, app.config.REVENUE_TIMEZONE),
  );
};
