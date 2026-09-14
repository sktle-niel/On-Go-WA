import type { AuthContext } from '../auth/guard.js';
import { displayNameOf } from '../auth/users.js';
import type { Database, Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../utils/errors.js';

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
export const QUOTE_SUBMITTED = 'quote.submitted';
export const QUOTE_UPDATED = 'quote.updated';

const MECHANIC_AUDIENCE = ['mechanic'] as const;

/** ONGO's priority fee per urgency, in pesos. Platform revenue, fixed on the
 *  request at creation. */
const SURCHARGE: Record<UrgencyName, number> = { Normal: 0, Urgent: 50, Emergency: 100 };

/** How long an urgency gives the mechanic to COMPLETE, in minutes. A quoted
 *  ETA (time to arrive) must fit inside what is left of it. Normal has no
 *  window — its timing is whatever ETA the mechanic promises. */
const WINDOW_MINUTES: Partial<Record<UrgencyName, number>> = { Emergency: 12 * 60, Urgent: 3 * 24 * 60 };

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

// ─── Slice 2: quotes ────────────────────────────────────────────────────────

export interface MechanicQuoteDto {
  id: string;
  requestId: string;
  mechanicId: string;
  mechanicName: string;
  price: number;
  etaMinutes: number;
  rating: number;
  accepted: boolean;
  withdrawnAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
}

interface QuoteRow {
  id: string;
  request_id: string;
  mechanic_id: string;
  price: number;
  eta_minutes: number;
  rating: number;
  accepted: boolean;
  withdrawn_at: Date | null;
  rejected_at: Date | null;
  created_at: Date;
  m_first: string;
  m_last: string;
  m_email: string;
}

const SELECT_QUOTE = `
  SELECT q.id, q.request_id, q.mechanic_id, q.price::float8 AS price, q.eta_minutes,
         q.rating::float8 AS rating, q.accepted, q.withdrawn_at, q.rejected_at, q.created_at,
         m.first_name AS m_first, m.last_name AS m_last, m.email AS m_email
    FROM quotes q
    JOIN users m ON m.id = q.mechanic_id`;

function toQuoteDto(row: QuoteRow): MechanicQuoteDto {
  return {
    id: row.id,
    requestId: row.request_id,
    mechanicId: row.mechanic_id,
    mechanicName: displayNameOf({ first_name: row.m_first, last_name: row.m_last, email: row.m_email }),
    price: row.price,
    etaMinutes: row.eta_minutes,
    rating: row.rating,
    accepted: row.accepted,
    withdrawnAt: row.withdrawn_at ? row.withdrawn_at.toISOString() : null,
    rejectedAt: row.rejected_at ? row.rejected_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function fetchQuote(db: Queryable, id: string): Promise<QuoteRow | null> {
  return db.queryOne<QuoteRow>(`${SELECT_QUOTE} WHERE q.id = $1`, [id]);
}

/** A mechanic may act on jobs only once their verification has been approved. */
async function mechanicIsApproved(db: Queryable, userId: string): Promise<boolean> {
  const row = await db.queryOne<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM account_requests WHERE user_id = $1 AND status = 'approved'::approval_status) AS ok`,
    [userId],
  );
  return row?.ok === true;
}

/** The mechanic's current average review rating, 0 when they have none yet. */
async function mechanicRating(db: Queryable, userId: string): Promise<number> {
  const row = await db.queryOne<{ rating: number }>(
    `SELECT COALESCE(AVG(rating), 0)::float8 AS rating FROM reviews WHERE mechanic_id = $1`,
    [userId],
  );
  return row?.rating ?? 0;
}

export async function submitQuote(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  requestId: string,
  input: { price: number; etaMinutes: number },
): Promise<MechanicQuoteDto> {
  if (!(await mechanicIsApproved(db, auth.userId))) {
    throw forbidden('Your mechanic account must be approved before you can send quotes.');
  }
  const rating = await mechanicRating(db, auth.userId);

  const quoteId = await db.withTransaction(async (tx) => {
    const req = await tx.queryOne<{ id: string; client_id: string; status: RequestStatusName; urgency: UrgencyName }>(
      `SELECT id, client_id, status::text AS status, urgency::text AS urgency
         FROM service_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    if (!req) throw notFound('Request not found.');
    if (req.status !== 'pending') throw conflict('This request is not open for quotes.');
    if (req.urgency === 'Emergency') throw conflict('Emergency jobs are accepted directly, not quoted.');

    const windowMinutes = WINDOW_MINUTES[req.urgency];
    if (windowMinutes !== undefined && input.etaMinutes > windowMinutes) {
      throw badRequest(`A ${req.urgency} job must be completed within its window; your ETA must be ${windowMinutes} minutes or less.`);
    }

    const existing = await tx.queryOne<{ id: string; accepted: boolean; withdrawn_at: Date | null; rejected_at: Date | null }>(
      `SELECT id, accepted, withdrawn_at, rejected_at FROM quotes
        WHERE request_id = $1 AND mechanic_id = $2 FOR UPDATE`,
      [requestId, auth.userId],
    );

    if (existing) {
      if (existing.rejected_at) throw conflict('The client rejected your quote for this job, so you cannot quote it again.');
      if (existing.accepted) throw conflict('Your quote for this job was already accepted.');
      if (!existing.withdrawn_at) throw conflict('You have already sent a quote for this job.');
      // Withdrawn: re-quote by reusing the row.
      await tx.query(
        `UPDATE quotes SET price = $2::numeric, eta_minutes = $3, rating = $4::numeric, withdrawn_at = NULL, created_at = now()
          WHERE id = $1`,
        [existing.id, input.price, input.etaMinutes, rating],
      );
      return existing.id;
    }

    const inserted = await tx.queryOne<{ id: string }>(
      `INSERT INTO quotes (request_id, mechanic_id, price, eta_minutes, rating)
       VALUES ($1, $2, $3::numeric, $4, $5::numeric)
       RETURNING id`,
      [requestId, auth.userId, input.price, input.etaMinutes, rating],
    );
    if (!inserted) throw new Error('quote insert produced no row');
    return inserted.id;
  });

  const row = await fetchQuote(db, quoteId);
  if (!row) throw new Error('quote vanished after submit');
  const dto = toQuoteDto(row);
  const owner = await db.queryOne<{ client_id: string }>(`SELECT client_id FROM service_requests WHERE id = $1`, [requestId]);
  if (owner) await events.publish({ name: QUOTE_SUBMITTED, data: dto, audience: { userIds: [owner.client_id] } });
  return dto;
}

export async function listQuotes(db: Queryable, auth: AuthContext, requestId: string): Promise<MechanicQuoteDto[]> {
  const req = await db.queryOne<{ client_id: string }>(`SELECT client_id FROM service_requests WHERE id = $1`, [requestId]);
  if (!req) throw notFound('Request not found.');
  const isConsole = auth.role === 'admin' || auth.role === 'moderator';
  const isOwner = req.client_id === auth.userId;

  let rows: QuoteRow[];
  if (isConsole) {
    rows = await db.query<QuoteRow>(`${SELECT_QUOTE} WHERE q.request_id = $1 ORDER BY q.created_at`, [requestId]);
  } else if (isOwner) {
    // The client sees live offers only — withdrawn and rejected ones are gone.
    rows = await db.query<QuoteRow>(
      `${SELECT_QUOTE} WHERE q.request_id = $1 AND q.withdrawn_at IS NULL AND q.rejected_at IS NULL ORDER BY q.created_at`,
      [requestId],
    );
  } else if (auth.role === 'mechanic') {
    // A mechanic sees only their own quote (any state, so they learn it was rejected).
    rows = await db.query<QuoteRow>(`${SELECT_QUOTE} WHERE q.request_id = $1 AND q.mechanic_id = $2`, [requestId, auth.userId]);
  } else {
    throw notFound('Request not found.');
  }
  return rows.map(toQuoteDto);
}

export async function withdrawQuote(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  requestId: string,
): Promise<MechanicQuoteDto> {
  const updated = await db.queryOne<{ id: string }>(
    `UPDATE quotes SET withdrawn_at = now()
      WHERE request_id = $1 AND mechanic_id = $2
        AND withdrawn_at IS NULL AND rejected_at IS NULL AND accepted = false
      RETURNING id`,
    [requestId, auth.userId],
  );
  if (!updated) throw notFound('You have no live quote on this request to withdraw.');

  const row = await fetchQuote(db, updated.id);
  if (!row) throw new Error('quote vanished after withdraw');
  const dto = toQuoteDto(row);
  const owner = await db.queryOne<{ client_id: string }>(`SELECT client_id FROM service_requests WHERE id = $1`, [requestId]);
  if (owner) await events.publish({ name: QUOTE_UPDATED, data: dto, audience: { userIds: [owner.client_id] } });
  return dto;
}

export async function rejectQuote(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  requestId: string,
  quoteId: string,
): Promise<MechanicQuoteDto> {
  // Only the request's client may reject, and only a live, unaccepted quote.
  const updated = await db.queryOne<{ id: string; mechanic_id: string }>(
    `UPDATE quotes q SET rejected_at = now()
      WHERE q.id = $1 AND q.request_id = $2
        AND q.withdrawn_at IS NULL AND q.rejected_at IS NULL AND q.accepted = false
        AND EXISTS (SELECT 1 FROM service_requests sr WHERE sr.id = q.request_id AND sr.client_id = $3)
      RETURNING q.id, q.mechanic_id`,
    [quoteId, requestId, auth.userId],
  );
  if (!updated) throw notFound('Quote not found.');

  const row = await fetchQuote(db, updated.id);
  if (!row) throw new Error('quote vanished after reject');
  const dto = toQuoteDto(row);
  await events.publish({ name: QUOTE_UPDATED, data: dto, audience: { userIds: [updated.mechanic_id] } });
  return dto;
}

// ─── Slice 3: accept (the atomic claim) ─────────────────────────────────────

function parties(dto: ServiceRequestDto): string[] {
  return [dto.clientId, dto.mechanicId].filter((id): id is string => id !== null);
}

/**
 * The client accepts a live quote. The request row is locked and flipped from
 * pending to matched in one step, so two accepts on the same request cannot
 * both win: the second sees a non-pending row and is refused.
 */
export async function acceptQuote(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  requestId: string,
  quoteId: string,
): Promise<ServiceRequestDto> {
  await db.withTransaction(async (tx) => {
    const req = await tx.queryOne<{ client_id: string; status: RequestStatusName }>(
      `SELECT client_id, status::text AS status FROM service_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    if (!req || req.client_id !== auth.userId) throw notFound('Request not found.');
    if (req.status !== 'pending') throw conflict('This request has already been matched or closed.');

    const q = await tx.queryOne<{ id: string; mechanic_id: string; withdrawn_at: Date | null; rejected_at: Date | null }>(
      `SELECT id, mechanic_id, withdrawn_at, rejected_at FROM quotes WHERE id = $1 AND request_id = $2 FOR UPDATE`,
      [quoteId, requestId],
    );
    if (!q || q.withdrawn_at || q.rejected_at) throw notFound('That quote is not available to accept.');

    await tx.query(
      `UPDATE service_requests SET status = 'matched'::request_status, mechanic_id = $2, accepted_at = now()
        WHERE id = $1 AND status = 'pending'::request_status`,
      [requestId, q.mechanic_id],
    );
    await tx.query(`UPDATE quotes SET accepted = (id = $2) WHERE request_id = $1`, [requestId, quoteId]);
  });

  const row = await fetchRequest(db, requestId);
  if (!row) throw new Error('request vanished after accept');
  const dto = toDto(row);
  await events.publish({ name: SERVICE_REQUEST_UPDATED, data: dto, audience: { userIds: parties(dto) } });
  return dto;
}

/**
 * A mechanic accepts an emergency directly (no quoting — the price is agreed in
 * person later). First-come: the guarded flip to matched lets exactly one
 * mechanic take it. One active emergency per mechanic, enforced by the partial
 * unique index (migration 008) as well as checked here for a clear message.
 */
export async function acceptEmergency(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  requestId: string,
  input: { etaMinutes: number },
): Promise<ServiceRequestDto> {
  if (!(await mechanicIsApproved(db, auth.userId))) {
    throw forbidden('Your mechanic account must be approved before you can accept jobs.');
  }
  const rating = await mechanicRating(db, auth.userId);
  const windowMinutes = WINDOW_MINUTES.Emergency ?? 12 * 60;
  if (input.etaMinutes > windowMinutes) {
    throw badRequest(`An Emergency must be completed within its window; your ETA must be ${windowMinutes} minutes or less.`);
  }

  try {
    await db.withTransaction(async (tx) => {
      const req = await tx.queryOne<{ status: RequestStatusName; urgency: UrgencyName }>(
        `SELECT status::text AS status, urgency::text AS urgency FROM service_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      if (!req) throw notFound('Request not found.');
      if (req.urgency !== 'Emergency') throw conflict('Only Emergency jobs are accepted directly; send a quote instead.');
      if (req.status !== 'pending') throw conflict('This emergency has already been taken.');

      const active = await tx.queryOne<{ one: number }>(
        `SELECT 1 AS one FROM service_requests
          WHERE mechanic_id = $1 AND urgency = 'Emergency'::urgency_level AND status = 'matched'::request_status
          LIMIT 1`,
        [auth.userId],
      );
      if (active) throw conflict('You already have an active emergency job.');

      await tx.query(
        `UPDATE service_requests SET status = 'matched'::request_status, mechanic_id = $2, accepted_at = now()
          WHERE id = $1 AND status = 'pending'::request_status`,
        [requestId, auth.userId],
      );
      // The emergency accept record: a quote marked accepted, price 0 (agreed
      // in person later via the payment slice).
      await tx.query(
        `INSERT INTO quotes (request_id, mechanic_id, price, eta_minutes, rating, accepted)
         VALUES ($1, $2, 0, $3, $4::numeric, true)
         ON CONFLICT (request_id, mechanic_id) DO UPDATE
           SET accepted = true, eta_minutes = $3, rating = $4::numeric, withdrawn_at = NULL, rejected_at = NULL`,
        [requestId, auth.userId, input.etaMinutes, rating],
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('You already have an active emergency job.');
    throw err;
  }

  const row = await fetchRequest(db, requestId);
  if (!row) throw new Error('request vanished after emergency accept');
  const dto = toDto(row);
  await events.publish({ name: SERVICE_REQUEST_UPDATED, data: dto, audience: { userIds: parties(dto) } });
  return dto;
}
