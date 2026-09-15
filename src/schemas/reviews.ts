import { Type } from '@fastify/type-provider-typebox';
import { DateTime, Nullable, StringEnum, Uuid } from './common.js';

/**
 * Reviews and the leaderboard. Not in on_go_shared yet; field names follow
 * MechanicReview in the mobile app's review_store.dart, with ids where the app
 * keyed people by name.
 */

export const Review = Type.Object({
  id: Uuid,
  mechanicId: Uuid,
  clientId: Uuid,
  clientName: Type.String(),
  /** The most recent job the mechanic completed for this client when the review was saved. */
  requestId: Nullable(Uuid),
  rating: Type.Integer({ minimum: 1, maximum: 5 }),
  comment: Type.String(),
  createdAt: DateTime,
  /** Moves on every edit; the app's MechanicReview.date. */
  updatedAt: DateTime,
  helpfulCount: Type.Integer(),
  likedByMe: Type.Boolean(),
});

export const SubmitReviewBody = Type.Object(
  {
    rating: Type.Integer({ minimum: 1, maximum: 5 }),
    comment: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);

const Share = Type.Number({ minimum: 0, maximum: 1 });

export const MechanicReviews = Type.Object({
  mechanicId: Uuid,
  /** Average rating over every review; 0 with none. */
  average: Type.Number(),
  count: Type.Integer(),
  /** Each star's share of the reviews, as ReviewStore.ratingDistributionFor; all 0 with none. */
  distribution: Type.Object({ '1': Share, '2': Share, '3': Share, '4': Share, '5': Share }),
  /** Newest first, at most 200. */
  reviews: Type.Array(Review),
});

export const ReviewIdParams = Type.Object({ reviewId: Uuid });

export const HelpfulState = Type.Object({
  reviewId: Uuid,
  helpfulCount: Type.Integer(),
  likedByMe: Type.Boolean(),
});

export const LeaderboardQuery = Type.Object({
  sort: Type.Optional(StringEnum(['rating', 'reviews'], { description: 'rating (default) or reviews' })),
  search: Type.Optional(Type.String({ maxLength: 100, description: 'A literal part of the mechanic name' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});

export const LeaderboardEntry = Type.Object({
  /** Place in the whole ranking for the chosen sort, before any search. */
  rank: Type.Integer(),
  mechanicId: Uuid,
  name: Type.String(),
  photoUrl: Nullable(Type.String()),
  rating: Type.Number(),
  reviewCount: Type.Integer(),
  completedJobs: Type.Integer(),
});
