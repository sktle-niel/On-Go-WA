import type { AuthContext } from '../auth/guard.js';
import { displayNameOf } from '../auth/users.js';
import type { Database, Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import { conflict, isUniqueViolation, notFound } from '../utils/errors.js';

/**
 * The jobs domain — slice 1: service requests (booking).
 *
 * A client books help; the request is open until a mechanic takes it (later
 * slices). The whole point of a booking service is that concurrent bookings
 * stay consistent, so two rules are enforced in the database, not the app:
 *
 *   - One ACTIVE request per client, via a partial unique index (migration
 *     006). A double-tap or a second device cannot create two live jobs.
 *   - State changes are guarded UPDATEs (`... WHERE status = 'pending'`), which
 *     take the row lock and only flip a row once, so concurrent actions on the
 *     same request serialize instead of racing.
 */

export type UrgencyName = 'Normal' | 'Urgent' | 'Emergency';
export type RequestStatusName = 'pending' | 'matched' | 'completed' | 'cancelled';

export const SERVICE_REQUEST_CREATED = 'service_request.created';
export const SERVICE_REQUEST_UPDATED = 'service_request.updated';

const MECHANIC_AUDIENCE = ['mechanic'] as const;

/** ONGO's priority fee per urgency, in pesos. Platform revenue, fixed on the
 *  request at creation. */
const SURCHARGE: Record<UrgencyName, number> = { Normal: 0, Urgent: 50, Emergency: 100 };

export interface ServiceRequestDto {
  id: string;
  clientId: string;
  clientName: string;
  problem: string;
  description: string;
  location: string;
  urgency: UrgencyName;
  surcharge: number;
  latitude: number | null;
  longitude: number | null;
  status: RequestStatusName;
  createdAt: string;
  matchedAt: string | null;
  completedAt: string | null;
  mechanicId: string | null;
  mechanicName: string | null;
  lastCancelReason: string | null;
  lastCancelledBy: string | null;
  lastCancelledAt: string | null;
  expiredAt: string | null;
  expiredByMechanic: string | null;
}

interface RequestRow {
  id: string;
  client_id: string;
  mechanic_id: string | null;
  status: RequestStatusName;
  urgency: UrgencyName;
  issue: string;
  description: string;
  location: string;
  surcharge: number;
  latitude: number | null;
  longitude: number | null;
  created_at: Date;
  accepted_at: Date | null;
  completed_at: Date | null;
  last_cancel_reason: string | null;
  last_cancelled_by: string | null;
  last_cancelled_at: Date | null;
  expired_at: Date | null;
  expired_by_mechanic: string | null;
  c_first: string;
  c_last: string;
  c_email: string;
  has_mechanic: boolean;
  m_first: string | null;
  m_last: string | null;
  m_email: string | null;
}

const SELECT_REQUEST = `
  SELECT sr.id, sr.client_id, sr.mechanic_id, sr.status::text AS status, sr.urgency::text AS urgency,
         sr.issue, sr.description, sr.location, sr.surcharge, sr.latitude, sr.longitude,
         sr.created_at, sr.accepted_at, sr.completed_at,
         sr.last_cancel_reason, sr.last_cancelled_by, sr.last_cancelled_at,
         sr.expired_at, sr.expired_by_mechanic,
         c.first_name AS c_first, c.last_name AS c_last, c.email AS c_email,
         (sr.mechanic_id IS NOT NULL) AS has_mechanic,
         m.first_name AS m_first, m.last_name AS m_last, m.email AS m_email
    FROM service_requests sr
    JOIN users c ON c.id = sr.client_id
    LEFT JOIN users m ON m.id = sr.mechanic_id`;

function toDto(row: RequestRow): ServiceRequestDto {
  const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: displayNameOf({ first_name: row.c_first, last_name: row.c_last, email: row.c_email }),
    problem: row.issue,
    description: row.description,
    location: row.location,
    urgency: row.urgency,
    surcharge: row.surcharge,
    latitude: row.latitude,
    longitude: row.longitude,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    matchedAt: iso(row.accepted_at),
    completedAt: iso(row.completed_at),
    mechanicId: row.mechanic_id,
    mechanicName: row.has_mechanic
      ? displayNameOf({ first_name: row.m_first ?? '', last_name: row.m_last ?? '', email: row.m_email ?? '' })
      : null,
    lastCancelReason: row.last_cancel_reason,
    lastCancelledBy: row.last_cancelled_by,
    lastCancelledAt: iso(row.last_cancelled_at),
    expiredAt: iso(row.expired_at),
    expiredByMechanic: row.expired_by_mechanic,
  };
}

function fetchRequest(db: Queryable, id: string): Promise<RequestRow | null> {
  return db.queryOne<RequestRow>(`${SELECT_REQUEST} WHERE sr.id = $1`, [id]);
}

export async function createServiceRequest(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  input: { problem: string; description?: string; location: string; urgency: UrgencyName; latitude?: number | null; longitude?: number | null },
): Promise<ServiceRequestDto> {
  const surcharge = SURCHARGE[input.urgency];
  let id: string;
  try {
    const inserted = await db.queryOne<{ id: string }>(
      `INSERT INTO service_requests
         (client_id, status, urgency, issue, description, location, latitude, longitude, surcharge)
       VALUES ($1, 'pending'::request_status, $2::urgency_level, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        auth.userId,
        input.urgency,
        input.problem.trim(),
        input.description?.trim() ?? '',
        input.location.trim(),
        input.latitude ?? null,
        input.longitude ?? null,
        surcharge,
      ],
    );
    if (!inserted) throw new Error('service request insert produced no row');
    id = inserted.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('You already have an active request. Finish or cancel it first.');
    throw err;
  }

  const row = await fetchRequest(db, id);
  if (!row) throw new Error('service request vanished after insert');
  const dto = toDto(row);
  // A new open job goes out to mechanics; the client sees their own too.
  await events.publish({ name: SERVICE_REQUEST_CREATED, data: dto, audience: { roles: MECHANIC_AUDIENCE, userIds: [auth.userId] } });
  return dto;
}

export async function listServiceRequests(
  db: Queryable,
  auth: AuthContext,
  filters: { scope?: 'open' | 'mine'; urgency?: UrgencyName },
): Promise<ServiceRequestDto[]> {
  const isConsole = auth.role === 'admin' || auth.role === 'moderator';
  const scope = filters.scope ?? 'mine';

  let where: string;
  const params: unknown[] = [];
  if (scope === 'open') {
    // The pool of pending jobs a mechanic can take.
    where = `sr.status = 'pending'::request_status`;
  } else if (isConsole) {
    where = 'TRUE';
  } else {
    // A client's own requests, or the jobs assigned to a mechanic.
    params.push(auth.userId);
    where = `(sr.client_id = $1 OR sr.mechanic_id = $1)`;
  }
  if (filters.urgency) {
    params.push(filters.urgency);
    where += ` AND sr.urgency = $${params.length}::urgency_level`;
  }

  const rows = await db.query<RequestRow>(`${SELECT_REQUEST} WHERE ${where} ORDER BY sr.created_at DESC`, params);
  return rows.map(toDto);
}

export async function getServiceRequest(db: Queryable, auth: AuthContext, id: string): Promise<ServiceRequestDto> {
  const row = await fetchRequest(db, id);
  if (!row) throw notFound('Request not found.');
  const isConsole = auth.role === 'admin' || auth.role === 'moderator';
  const isOwner = row.client_id === auth.userId;
  const isAssigned = row.mechanic_id === auth.userId;
  const isOpenToMechanics = auth.role === 'mechanic' && row.status === 'pending';
  if (!isConsole && !isOwner && !isAssigned && !isOpenToMechanics) throw notFound('Request not found.');
  return toDto(row);
}

export async function cancelServiceRequest(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  id: string,
  reason: string | null,
): Promise<ServiceRequestDto> {
  const existing = await fetchRequest(db, id);
  if (!existing || existing.client_id !== auth.userId) throw notFound('Request not found.');
  if (existing.status !== 'pending') {
    // Matched jobs gain an ETA-lock rule with the acceptance slice; a decided
    // (completed/cancelled) request cannot be cancelled again.
    throw conflict('This request can no longer be cancelled.');
  }

  // Guarded so a mechanic accepting at this instant (a later slice) cannot race
  // the cancel: only a still-pending row is flipped.
  const updated = await db.queryOne<{ id: string }>(
    `UPDATE service_requests
        SET status = 'cancelled'::request_status,
            last_cancel_reason = $2, last_cancelled_by = $3, last_cancelled_at = now()
      WHERE id = $1 AND client_id = $4 AND status = 'pending'::request_status
      RETURNING id`,
    [id, reason?.trim() || null, auth.displayName, auth.userId],
  );
  if (!updated) throw conflict('This request can no longer be cancelled.');

  const row = await fetchRequest(db, id);
  if (!row) throw new Error('request vanished after cancel');
  const dto = toDto(row);
  await events.publish({ name: SERVICE_REQUEST_UPDATED, data: dto, audience: { roles: MECHANIC_AUDIENCE, userIds: [auth.userId] } });
  return dto;
}
