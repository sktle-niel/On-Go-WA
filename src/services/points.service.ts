import type { AuthContext } from '../auth/guard.js';
import type { Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import { recordSecurityEvent, SecurityEvent } from '../logging/audit.js';

/**
 * The points policy: one row every screen on both apps reads, and the console
 * edits. The mobile app loads it before sign-in, so reading is public.
 */

export interface PointsPolicyDto {
  clientNormal: number;
  clientUrgent: number;
  clientEmergency: number;
  mechanicPerPeso: number;
}

const SELECT_POLICY = `
  SELECT client_normal::float8     AS "clientNormal",
         client_urgent::float8     AS "clientUrgent",
         client_emergency::float8  AS "clientEmergency",
         mechanic_per_peso::float8 AS "mechanicPerPeso"
    FROM points_policy WHERE id = 1`;

export async function getPointsPolicy(db: Queryable): Promise<PointsPolicyDto> {
  const row = await db.queryOne<PointsPolicyDto>(SELECT_POLICY);
  if (!row) throw new Error('points_policy row is missing; run migrations');
  return row;
}

export const POINTS_POLICY_UPDATED = 'points_policy.updated';

export async function updatePointsPolicy(
  db: Queryable,
  events: EventBus,
  auth: AuthContext,
  policy: PointsPolicyDto,
  meta: { ipHash: Buffer; requestId: string },
): Promise<PointsPolicyDto> {
  const row = await db.queryOne<PointsPolicyDto>(
    `UPDATE points_policy
        SET client_normal = $1::numeric,
            client_urgent = $2::numeric,
            client_emergency = $3::numeric,
            mechanic_per_peso = $4::numeric,
            updated_at = now(),
            updated_by = $5
      WHERE id = 1
      RETURNING client_normal::float8     AS "clientNormal",
                client_urgent::float8     AS "clientUrgent",
                client_emergency::float8  AS "clientEmergency",
                mechanic_per_peso::float8 AS "mechanicPerPeso"`,
    [policy.clientNormal, policy.clientUrgent, policy.clientEmergency, policy.mechanicPerPeso, auth.userId],
  );
  if (!row) throw new Error('points_policy row is missing; run migrations');

  await recordSecurityEvent(db, {
    event: SecurityEvent.ADMIN_ACTION,
    severity: 'notice',
    actorId: auth.userId,
    actorRole: auth.role,
    targetType: 'points_policy',
    ipHash: meta.ipHash,
    requestId: meta.requestId,
    metadata: { action: 'update' },
  });
  await events.publish({ name: POINTS_POLICY_UPDATED, data: row });
  return row;
}
