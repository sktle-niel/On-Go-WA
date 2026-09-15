import type { AuthContext } from '../auth/guard.js';
import { escapeLike, type Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import { forbidden, notFound } from '../utils/errors.js';

/**
 * Reviews and the leaderboard.
 *
 * A client rates a mechanic from 1 to 5 stars with an optional comment. The
 * rules come from the mobile app's ReviewStore, plus one the server adds:
 *
 *   - One review per client per mechanic: submitting again edits it. The
 *     reviews_one_per_pair constraint (migration 001) holds that in the database.
 *   - Only a client the mechanic has actually served may review: at least one
 *     completed, paid job between them. The app did not check this, but a
 *     rating that feeds quotes and the leaderboard must not be open to anyone.
 *   - Anyone on the mobile app may mark a review helpful, once.
 *
 * The leaderboard ranks approved, active mechanics by average rating, or by
 * review count, from the same rows. Names shown to everyone never fall back to
 * an email address.
 */

export const REVIEW_SUBMITTED = 'review.submitted';

export interface ReviewDto {
  id: string;
  mechanicId: string;
  clientId: string;
  clientName: string;
  requestId: string | null;
  rating: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
  helpfulCount: number;
  likedByMe: boolean;
}

export interface MechanicReviewsDto {
  mechanicId: string;
  average: number;
  count: number;
  distribution: { '1': number; '2': number; '3': number; '4': number; '5': number };
  reviews: ReviewDto[];
}

export interface HelpfulStateDto {
  reviewId: string;
  helpfulCount: number;
  likedByMe: boolean;
}

export interface LeaderboardEntryDto {
  rank: number;
  mechanicId: string;
  name: string;
  photoUrl: string | null;
  rating: number;
  reviewCount: number;
  completedJobs: number;
}

const REVIEW_LIST_LIMIT = 200;

interface ReviewRow {
  id: string;
  mechanic_id: string;
  client_id: string;
  request_id: string | null;
  rating: number;
  comment: string;
  created_at: Date;
  updated_at: Date;
  client_name: string;
  helpful_count: number;
  liked_by_me: boolean;
}

/** Every review read goes through this; `$1` is the viewer, for likedByMe. */
const SELECT_REVIEW = `
  SELECT r.id, r.mechanic_id, r.client_id, r.request_id, r.rating::int AS rating, r.comment,
         r.created_at, r.updated_at,
         COALESCE(NULLIF(btrim(c.first_name || ' ' || c.last_name), ''), 'Client') AS client_name,
         (SELECT count(*)::int FROM review_likes l WHERE l.review_id = r.id) AS helpful_count,
         EXISTS (SELECT 1 FROM review_likes l WHERE l.review_id = r.id AND l.user_id = $1::uuid) AS liked_by_me
    FROM reviews r
    JOIN users c ON c.id = r.client_id`;

function toDto(row: ReviewRow): ReviewDto {
  return {
    id: row.id,
    mechanicId: row.mechanic_id,
    clientId: row.client_id,
    clientName: row.client_name,
    requestId: row.request_id,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    helpfulCount: row.helpful_count,
    likedByMe: row.liked_by_me,
  };
}

async function assertMechanic(db: Queryable, mechanicId: string): Promise<void> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND role = 'mechanic'::user_role`,
    [mechanicId],
  );
  if (!row) throw notFound('Mechanic not found.');
}

/**
 * Creates the client's review of a mechanic, or edits the one they already
 * left, in one statement. The review points at the most recent job the
 * mechanic completed for them.
 */
export async function submitReview(
  db: Queryable,
  events: EventBus,
  auth: AuthContext,
  mechanicId: string,
  input: { rating: number; comment?: string },
): Promise<ReviewDto> {
  await assertMechanic(db, mechanicId);
  const job = await db.queryOne<{ id: string }>(
    `SELECT id FROM service_requests
      WHERE client_id = $1 AND mechanic_id = $2 AND status = 'completed'::request_status
      ORDER BY completed_at DESC NULLS LAST
      LIMIT 1`,
    [auth.userId, mechanicId],
  );
  if (!job) throw forbidden('You can review a mechanic once they have completed a paid job for you.');

  const saved = await db.queryOne<{ id: string }>(
    `INSERT INTO reviews (request_id, client_id, mechanic_id, rating, comment)
     VALUES ($1, $2, $3, $4::smallint, $5)
     ON CONFLICT (client_id, mechanic_id) DO UPDATE
       SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, request_id = EXCLUDED.request_id
     RETURNING id`,
    [job.id, auth.userId, mechanicId, input.rating, (input.comment ?? '').trim()],
  );
  if (!saved) throw new Error('review upsert produced no row');

  const row = await db.queryOne<ReviewRow>(`${SELECT_REVIEW} WHERE r.id = $2::uuid`, [auth.userId, saved.id]);
  if (!row) throw new Error('review vanished after saving');
  const dto = toDto(row);
  // The app's "You received a rating" notice, for a new review and an edit alike.
  await events.publish({ name: REVIEW_SUBMITTED, data: dto, audience: { userIds: [mechanicId] } });
  return dto;
}

/**
 * A mechanic's reviews, newest first, with the summary their profile shows:
 * the average (0 with no reviews) and each star's share of the reviews, as
 * ReviewStore.ratingDistributionFor computes it. The summary covers every
 * review; the list is capped at the newest 200.
 */
export async function listMechanicReviews(
  db: Queryable,
  auth: AuthContext,
  mechanicId: string,
): Promise<MechanicReviewsDto> {
  await assertMechanic(db, mechanicId);
  const summary = await db.queryOne<{ count: number; average: number; s1: number; s2: number; s3: number; s4: number; s5: number }>(
    `SELECT count(*)::int AS count,
            COALESCE(avg(rating), 0)::float8 AS average,
            count(*) FILTER (WHERE rating = 1)::int AS s1,
            count(*) FILTER (WHERE rating = 2)::int AS s2,
            count(*) FILTER (WHERE rating = 3)::int AS s3,
            count(*) FILTER (WHERE rating = 4)::int AS s4,
            count(*) FILTER (WHERE rating = 5)::int AS s5
       FROM reviews WHERE mechanic_id = $1`,
    [mechanicId],
  );
  const rows = await db.query<ReviewRow>(
    `${SELECT_REVIEW} WHERE r.mechanic_id = $2::uuid ORDER BY r.created_at DESC, r.id LIMIT $3`,
    [auth.userId, mechanicId, REVIEW_LIST_LIMIT],
  );

  const count = summary?.count ?? 0;
  const share = (n: number | undefined) => (count === 0 ? 0 : (n ?? 0) / count);
  return {
    mechanicId,
    average: summary?.average ?? 0,
    count,
    distribution: {
      '1': share(summary?.s1),
      '2': share(summary?.s2),
      '3': share(summary?.s3),
      '4': share(summary?.s4),
      '5': share(summary?.s5),
    },
    reviews: rows.map(toDto),
  };
}

/** Marks a review helpful for the caller, or takes the mark back. Repeating either changes nothing. */
export async function setReviewHelpful(
  db: Queryable,
  auth: AuthContext,
  reviewId: string,
  helpful: boolean,
): Promise<HelpfulStateDto> {
  const review = await db.queryOne<{ id: string }>(`SELECT id FROM reviews WHERE id = $1`, [reviewId]);
  if (!review) throw notFound('Review not found.');

  if (helpful) {
    await db.query(
      `INSERT INTO review_likes (review_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [reviewId, auth.userId],
    );
  } else {
    await db.query(`DELETE FROM review_likes WHERE review_id = $1 AND user_id = $2`, [reviewId, auth.userId]);
  }

  const state = await db.queryOne<{ helpful_count: number; liked_by_me: boolean }>(
    `SELECT count(*)::int AS helpful_count, COALESCE(bool_or(user_id = $2::uuid), false) AS liked_by_me
       FROM review_likes WHERE review_id = $1`,
    [reviewId, auth.userId],
  );
  return { reviewId, helpfulCount: state?.helpful_count ?? 0, likedByMe: state?.liked_by_me ?? false };
}

/**
 * Approved, active mechanics, ranked. By rating: average rating, then review
 * count, then completed jobs. By reviews: review count first. Ties fall back to
 * name. `rank` is the mechanic's place in the whole ranking, so a search does
 * not renumber the mechanics it finds.
 */
export async function leaderboard(
  db: Queryable,
  filters: { sort?: 'rating' | 'reviews'; search?: string; limit?: number },
): Promise<LeaderboardEntryDto[]> {
  const search = filters.search?.trim();
  const rows = await db.query<{
    id: string;
    name: string;
    photo_url: string | null;
    rating: number;
    review_count: number;
    completed_jobs: number;
    rank: number;
  }>(
    `WITH stats AS (
       SELECT u.id,
              COALESCE(NULLIF(btrim(u.first_name || ' ' || u.last_name), ''), 'Mechanic') AS name,
              NULLIF(u.photo_url, '') AS photo_url,
              (SELECT COALESCE(avg(r.rating), 0)::float8 FROM reviews r WHERE r.mechanic_id = u.id) AS rating,
              (SELECT count(*)::int FROM reviews r WHERE r.mechanic_id = u.id) AS review_count,
              (SELECT count(*)::int FROM service_requests sr
                WHERE sr.mechanic_id = u.id AND sr.status = 'completed'::request_status) AS completed_jobs
         FROM users u
        WHERE u.role = 'mechanic'::user_role
          AND u.status = 'active'::user_status
          AND EXISTS (SELECT 1 FROM account_requests ar
                       WHERE ar.user_id = u.id AND ar.status = 'approved'::approval_status)
     ),
     ranked AS (
       SELECT stats.*,
              row_number() OVER (
                ORDER BY CASE WHEN $1::boolean THEN review_count END DESC NULLS LAST,
                         rating DESC, review_count DESC, completed_jobs DESC, name, id
              )::int AS rank
         FROM stats
     )
     SELECT id, name, photo_url, rating, review_count, completed_jobs, rank
       FROM ranked
      WHERE $2::text IS NULL OR name ILIKE '%' || $2 || '%' ESCAPE '\\'
      ORDER BY rank
      LIMIT $3`,
    [filters.sort === 'reviews', search ? escapeLike(search) : null, filters.limit ?? 50],
  );
  return rows.map((row) => ({
    rank: row.rank,
    mechanicId: row.id,
    name: row.name,
    photoUrl: row.photo_url,
    rating: row.rating,
    reviewCount: row.review_count,
    completedJobs: row.completed_jobs,
  }));
}
