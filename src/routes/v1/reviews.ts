import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import { currentAuth, MOBILE_ROLES, requireAuth } from '../../auth/guard.js';
import { errorResponses, MechanicIdParams } from '../../schemas/common.js';
import {
  HelpfulState,
  LeaderboardEntry,
  LeaderboardQuery,
  MechanicReviews,
  Review,
  ReviewIdParams,
  SubmitReviewBody,
} from '../../schemas/reviews.js';
import {
  leaderboard,
  listMechanicReviews,
  setReviewHelpful,
  submitReview,
} from '../../services/reviews.service.js';

/**
 * Reviews and the leaderboard. Not in on_go_shared yet; see PROJECT.md →
 * Contract gaps. The rules live in services/reviews.service.ts.
 */
export const reviewRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.put(
    '/mechanics/:mechanicId/review',
    {
      preHandler: [requireAuth({ roles: ['client'] })],
      schema: {
        tags: ['Reviews'],
        summary: 'Review a mechanic',
        description:
          'Addition. The client rates a mechanic 1 to 5 with an optional comment. One review per client ' +
          'per mechanic: sending it again edits it. Allowed only once the mechanic has completed a paid ' +
          'job for this client (403 before). Publishes `review.submitted` to the mechanic.',
        security: [{ bearerAuth: [] }],
        params: MechanicIdParams,
        body: SubmitReviewBody,
        response: { 200: Review, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) =>
      submitReview(app.db, app.events, currentAuth(request), request.params.mechanicId, request.body),
  );

  app.get(
    '/mechanics/:mechanicId/reviews',
    {
      preHandler: [requireAuth()],
      schema: {
        tags: ['Reviews'],
        summary: "A mechanic's reviews",
        description:
          'Addition. Newest first (at most 200), with the average, count and star distribution over every ' +
          'review, and whether each review is marked helpful by the caller.',
        security: [{ bearerAuth: [] }],
        params: MechanicIdParams,
        response: { 200: MechanicReviews, ...errorResponses(401, 404) },
      },
    },
    async (request) => listMechanicReviews(app.db, currentAuth(request), request.params.mechanicId),
  );

  app.put(
    '/reviews/:reviewId/helpful',
    {
      preHandler: [requireAuth({ roles: MOBILE_ROLES })],
      schema: {
        tags: ['Reviews'],
        summary: 'Mark a review helpful',
        description: 'Addition. Once per person; repeating it changes nothing.',
        security: [{ bearerAuth: [] }],
        params: ReviewIdParams,
        response: { 200: HelpfulState, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => setReviewHelpful(app.db, currentAuth(request), request.params.reviewId, true),
  );

  app.delete(
    '/reviews/:reviewId/helpful',
    {
      preHandler: [requireAuth({ roles: MOBILE_ROLES })],
      schema: {
        tags: ['Reviews'],
        summary: 'Take back a helpful mark',
        description: 'Addition. Repeating it changes nothing.',
        security: [{ bearerAuth: [] }],
        params: ReviewIdParams,
        response: { 200: HelpfulState, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => setReviewHelpful(app.db, currentAuth(request), request.params.reviewId, false),
  );

  app.get(
    '/leaderboard',
    {
      preHandler: [requireAuth()],
      schema: {
        tags: ['Reviews'],
        summary: 'The mechanic leaderboard',
        description:
          'Addition. Approved, active mechanics ranked by average rating (then review count, then ' +
          'completed jobs), or with `sort=reviews` by review count first. `search` matches part of the ' +
          'name literally; `rank` stays the place in the whole ranking. No tier: the app\'s "Gold" was a ' +
          'placeholder with no rule behind it.',
        security: [{ bearerAuth: [] }],
        querystring: LeaderboardQuery,
        response: { 200: Type.Array(LeaderboardEntry), ...errorResponses(400, 401) },
      },
    },
    async (request) =>
      leaderboard(app.db, { sort: request.query.sort, search: request.query.search, limit: request.query.limit }),
  );
};
