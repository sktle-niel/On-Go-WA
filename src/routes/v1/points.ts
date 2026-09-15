import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { currentAuth, MOBILE_ROLES, requireAuth } from '../../auth/guard.js';
import { errorResponses } from '../../schemas/common.js';
import { ConvertPointsBody, PointsPolicy, PointsWallet } from '../../schemas/points.js';
import {
  convertPointsToBalance,
  getPointsPolicy,
  getWallet,
  updatePointsPolicy,
} from '../../services/points.service.js';
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

  // ── The points wallet ─────────────────────────────────────────────────────

  app.get(
    '/points/wallet',
    {
      preHandler: [requireAuth({ roles: MOBILE_ROLES })],
      schema: {
        tags: ['Points'],
        summary: 'Your points wallet',
        description:
          'Addition. The caller\'s balance (the sum of every entry) and newest entries, plus, for a ' +
          'mechanic, the earnings from paid jobs and the pesos converted from points.',
        security: [{ bearerAuth: [] }],
        response: { 200: PointsWallet, ...errorResponses(401, 403) },
      },
    },
    async (request) => getWallet(app.db, currentAuth(request)),
  );

  app.post(
    '/points/convert',
    {
      preHandler: [requireAuth({ roles: ['mechanic'] })],
      schema: {
        tags: ['Points'],
        summary: 'Convert points to balance',
        description:
          'Addition. A mechanic turns points into account balance at 1 pt = ₱1: at least 1 point, and ' +
          'never more than the balance (409).',
        security: [{ bearerAuth: [] }],
        body: ConvertPointsBody,
        response: { 200: PointsWallet, ...errorResponses(400, 401, 403, 409) },
      },
    },
    async (request) => convertPointsToBalance(app.db, currentAuth(request), request.body.points),
  );
};
