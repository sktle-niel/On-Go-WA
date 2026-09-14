import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { currentAuth, requireAuth } from '../../auth/guard.js';
import { errorResponses } from '../../schemas/common.js';
import { PointsPolicy } from '../../schemas/points.js';
import { getPointsPolicy, updatePointsPolicy } from '../../services/points.service.js';
import { clientIpHash } from '../../utils/ip.js';

export const pointsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/platform/points-policy',
    {
      schema: {
        tags: ['Platform'],
        summary: 'The points policy',
        description: 'PointsPolicyApi.fetch. Public: the mobile app reads it before sign-in.',
        response: { 200: PointsPolicy },
      },
    },
    async () => getPointsPolicy(app.db),
  );

  app.put(
    '/platform/points-policy',
    {
      preHandler: [requireAuth({ roles: ['admin'] })],
      schema: {
        tags: ['Platform'],
        summary: 'Replace the points policy',
        description: 'PointsPolicyApi.update. Admin only. Publishes `points_policy.updated` on the event socket.',
        security: [{ bearerAuth: [] }],
        body: PointsPolicy,
        response: { 200: PointsPolicy, ...errorResponses(400, 401, 403) },
      },
    },
    async (request) =>
      updatePointsPolicy(app.db, app.events, currentAuth(request), request.body, {
        ipHash: clientIpHash(request),
        requestId: request.id,
      }),
  );
};
