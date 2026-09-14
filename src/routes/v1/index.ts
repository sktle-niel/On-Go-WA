import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { appearanceRoutes } from './appearance.js';
import { authRoutes } from './auth.js';
import { eventRoutes } from './events.js';
import { moderatorRoutes } from './moderators.js';
import { pointsRoutes } from './points.js';
import { revenueRoutes } from './revenue.js';
import { verificationRoutes } from './verification.js';

/**
 * Everything under /api/v1 — the same paths as `ApiEndpoints` in
 * packages/on_go_shared. Bump the prefix rather than changing a path in place.
 */
export const v1Routes: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(verificationRoutes);
  await app.register(moderatorRoutes);
  await app.register(revenueRoutes);
  await app.register(appearanceRoutes);
  await app.register(pointsRoutes);
  await app.register(eventRoutes);
};
