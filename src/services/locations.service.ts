import type { AuthContext } from '../auth/guard.js';
import type { Queryable } from '../db/database.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';

/**
 * Locations — LocationApi.
 *
 * The phone reports where it is and the server keeps the latest fix per user.
 * Three rules shape everything here:
 *
 *   - The subject is the token holder. A `userId` in the body is ignored, a
 *     `role` must be the caller's own, and only a mechanic has availability.
 *   - A location is personal data. It is readable by its owner, by the console,
 *     and by the other party of an ACTIVE (matched) job, and by nobody else.
 *     Everyone else gets 404, the same answer as "never reported".
 *   - "Nearby" is isJobWithinServiceRadius, exactly: a radius above zero, the
 *     mechanic available or availability unset, valid points, and a distance
 *     within the radius with the edge counting as inside, measured by
 *     ongo_great_circle_m, the same haversine as GeoPoint.distanceTo.
 */

export type LocationSourceName = 'gps' | 'lastKnown' | 'manual';
export type LocationRoleName = 'client' | 'mechanic';
export type AvailabilityName = 'available' | 'onJob' | 'offline';

export interface LocationUpdateDto {
  point: { latitude: number; longitude: number };
  recordedAt: string;
  accuracyMeters: number | null;
  source: LocationSourceName;
  userId: string;
  role: LocationRoleName;
  availability: AvailabilityName | null;
}

export interface LocationUpdateInput {
  point: { latitude: number; longitude: number };
  recordedAt: string;
  accuracyMeters?: number | null;
  source: LocationSourceName;
  userId?: string | null;
  role?: LocationRoleName | null;
  availability?: AvailabilityName | null;
}

/** How far ahead of the server's clock a device may stamp a fix before it is refused. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface LocationRow {
  user_id: string;
  latitude: number;
  longitude: number;
  recorded_at: Date;
  accuracy_m: number | null;
  source: LocationSourceName;
  role: LocationRoleName;
  availability: AvailabilityName | null;
}

function toDto(row: LocationRow): LocationUpdateDto {
  return {
    point: { latitude: row.latitude, longitude: row.longitude },
    recordedAt: row.recorded_at.toISOString(),
    accuracyMeters: row.accuracy_m,
    source: row.source,
    userId: row.user_id,
    role: row.role,
    availability: row.availability,
  };
}

const isConsole = (auth: AuthContext) => auth.role === 'admin' || auth.role === 'moderator';

/**
 * Records the caller's latest fix, replacing the one before. Each report is
 * the whole current state, so a mechanic who leaves availability out has it
 * unset (which counts as available), exactly as LocationUpdate carries it.
 */
export async function reportLocation(db: Queryable, auth: AuthContext, input: LocationUpdateInput): Promise<void> {
  const role: LocationRoleName | null = auth.role === 'client' || auth.role === 'mechanic' ? auth.role : null;
  if (role === null) throw forbidden('Only a client or mechanic reports a location.');
  if (input.role != null && input.role !== role) throw badRequest("role must be the signed-in account's own role.");
  const availability = input.availability ?? null;
  if (availability !== null && role !== 'mechanic') throw badRequest('Only a mechanic reports availability.');
  if (Date.parse(input.recordedAt) > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw badRequest('recordedAt is ahead of the server clock.');
  }

  await db.query(
    `INSERT INTO user_locations
       (user_id, latitude, longitude, recorded_at, accuracy_m, source, role, availability, updated_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6::location_source, $7::location_role, $8::mechanic_availability, now())
     ON CONFLICT (user_id) DO UPDATE
       SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
           recorded_at = EXCLUDED.recorded_at, accuracy_m = EXCLUDED.accuracy_m,
           source = EXCLUDED.source, role = EXCLUDED.role,
           availability = EXCLUDED.availability, updated_at = now()`,
    [
      auth.userId,
      input.point.latitude,
      input.point.longitude,
      input.recordedAt,
      input.accuracyMeters ?? null,
      input.source,
      role,
      availability,
    ],
  );
}

/** A user's last known location, if the caller may see it. The visibility rule is in the query. */
export async function fetchLastKnown(db: Queryable, auth: AuthContext, userId: string): Promise<LocationUpdateDto> {
  const row = await db.queryOne<LocationRow>(
    `SELECT ul.user_id, ul.latitude, ul.longitude, ul.recorded_at, ul.accuracy_m,
            ul.source::text AS source, ul.role::text AS role, ul.availability::text AS availability
       FROM user_locations ul
      WHERE ul.user_id = $1
        AND ($3::boolean
             OR ul.user_id = $2::uuid
             OR EXISTS (
                  SELECT 1 FROM service_requests sr
                   WHERE sr.status = 'matched'::request_status
                     AND ((sr.client_id = $2::uuid AND sr.mechanic_id = ul.user_id)
                       OR (sr.mechanic_id = $2::uuid AND sr.client_id = ul.user_id))
                ))`,
    [userId, auth.userId, isConsole(auth)],
  );
  if (!row) throw notFound('No location for that user.');
  return toDto(row);
}

/**
 * Pending jobs within `radiusKm` of the mechanic's last reported location,
 * nearest first. Asked by the mechanic themself or the console.
 */
export async function findNearbyJobIds(
  db: Queryable,
  auth: AuthContext,
  mechanicId: string,
  radiusKm: number,
): Promise<string[]> {
  if (!isConsole(auth) && auth.userId !== mechanicId) throw notFound('Mechanic not found.');
  const mechanic = await db.queryOne<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND role = 'mechanic'::user_role`,
    [mechanicId],
  );
  if (!mechanic) throw notFound('Mechanic not found.');
  if (!(radiusKm > 0)) return [];

  const rows = await db.query<{ id: string }>(
    `SELECT sr.id
       FROM user_locations ul
       JOIN service_requests sr
         ON sr.status = 'pending'::request_status
        AND sr.latitude BETWEEN -90 AND 90
        AND sr.longitude BETWEEN -180 AND 180
      WHERE ul.user_id = $1
        AND (ul.availability IS NULL OR ul.availability = 'available'::mechanic_availability)
        AND ongo_great_circle_m(ul.latitude, ul.longitude, sr.latitude, sr.longitude) / 1000 <= $2::double precision
      ORDER BY ongo_great_circle_m(ul.latitude, ul.longitude, sr.latitude, sr.longitude), sr.created_at`,
    [mechanicId, radiusKm],
  );
  return rows.map((row) => row.id);
}
