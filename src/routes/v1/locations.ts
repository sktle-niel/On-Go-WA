import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import { currentAuth, MOBILE_ROLES, requireAuth } from '../../auth/guard.js';
import { errorResponses, MechanicIdParams, NoContent, Uuid } from '../../schemas/common.js';
import {
  LocationUpdate,
  LocationUpdateBody,
  NearbyJobsQuery,
  UserIdParams,
} from '../../schemas/locations.js';
import { fetchLastKnown, findNearbyJobIds, reportLocation } from '../../services/locations.service.js';

/**
 * LocationApi: the routes ApiEndpoints.locations, userLocation and nearbyJobs
 * name in on_go_shared. The rules live in services/locations.service.ts.
 */
export const locationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/locations',
    {
      preHandler: [requireAuth({ roles: MOBILE_ROLES })],
      schema: {
        tags: ['Locations'],
        summary: 'Report your location',
        description:
          'LocationApi.reportLocation. Keeps the latest fix per account; each report replaces the last. ' +
          'The subject is the token holder: `userId` in the body is ignored, `role` must be your own, ' +
          'and only a mechanic may send `availability` (unset counts as available). A fix stamped more ' +
          'than 5 minutes ahead of the server clock is refused.',
        security: [{ bearerAuth: [] }],
        body: LocationUpdateBody,
        response: { 204: NoContent, ...errorResponses(400, 401, 403) },
      },
    },
    async (request, reply) => {
      await reportLocation(app.db, currentAuth(request), request.body);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/users/:userId/location',
    {
      preHandler: [requireAuth()],
      schema: {
        tags: ['Locations'],
        summary: "A user's last known location",
        description:
          'LocationApi.fetchLastKnown. Your own; any user\'s for a console role; or the other party\'s on ' +
          'a job you are matched on. Anyone else, and a user who never reported, gets 404, which the ' +
          'app reads as null.',
        security: [{ bearerAuth: [] }],
        params: UserIdParams,
        response: { 200: LocationUpdate, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => fetchLastKnown(app.db, currentAuth(request), request.params.userId),
  );

  app.get(
    '/mechanics/:mechanicId/nearby-jobs',
    {
      preHandler: [requireAuth({ roles: ['mechanic', 'admin', 'moderator'] })],
      schema: {
        tags: ['Locations'],
        summary: 'Open jobs near a mechanic',
        description:
          'LocationApi.findNearbyJobIds, by isJobWithinServiceRadius: ids of pending jobs with coordinates ' +
          'within `radiusKm` of the mechanic\'s last reported location, the edge counting as inside, ' +
          'nearest first. Empty when the radius is not above zero, the mechanic never reported, or their ' +
          'availability is `onJob` or `offline`. The mechanic themself or a console role; 404 otherwise.',
        security: [{ bearerAuth: [] }],
        params: MechanicIdParams,
        querystring: NearbyJobsQuery,
        response: { 200: Type.Array(Uuid), ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) =>
      findNearbyJobIds(app.db, currentAuth(request), request.params.mechanicId, request.query.radiusKm),
  );
};
