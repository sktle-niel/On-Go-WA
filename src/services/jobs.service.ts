import type { AuthContext } from '../auth/guard.js';
import { displayNameOf } from '../auth/users.js';
import type { Database, Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import { recordSecurityEvent, SecurityEvent } from '../logging/audit.js';
import { AppError, badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../utils/errors.js';

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
  /** When an Urgent or Emergency job must be under way by; null for Normal or an unmatched job. */
  deadlineAt: string | null;
  /** When the matched mechanic promised to arrive: matchedAt plus the accepted quote's ETA. */
  expectedArrivalAt: string | null;
  mechanicId: string | null;
  mechanicName: string | null;
  navigating: boolean;
  navigatingAt: string | null;
  enRoute: boolean;
  enRouteAt: string | null;
  arrived: boolean;
  arrivedAt: string | null;
  workStarted: boolean;
  workStartedAt: string | null;
  serviceCompleted: boolean;
  serviceCompletedAt: string | null;
  lastCancelReason: string | null;
  lastCancelledBy: string | null;
  lastCancelledAt: string | null;
  expiredAt: string | null;
  expiredByMechanic: string | null;
  // Payment (slice 5): null until the job is paid, except the agreed amount.
  agreedPaymentAmount: number | null;
  agreedPaymentAmountSetAt: string | null;
  paymentCompleted: boolean;
  paymentCompletedAt: string | null;
  amountPaid: number | null;
  platformFeeCharged: number | null;
  feePaidWithPoints: number | null;
  pointsAwarded: number | null;
  clientPointsAwarded: number | null;
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
  deadline_at: Date | null;
  expected_arrival_at: Date | null;
  navigating: boolean;
  navigating_at: Date | null;
  en_route: boolean;
  en_route_at: Date | null;
  arrived: boolean;
  arrived_at: Date | null;
  work_started: boolean;
  work_started_at: Date | null;
  service_completed: boolean;
  service_completed_at: Date | null;
  last_cancel_reason: string | null;
  last_cancelled_by: string | null;
  last_cancelled_at: Date | null;
  expired_at: Date | null;
  expired_by_mechanic: string | null;
  agreed_amount: number | null;
  agreed_amount_set_at: Date | null;
  has_payment: boolean;
  amount_paid: number | null;
  platform_fee_charged: number | null;
  fee_paid_with_points: number | null;
  mechanic_points: number | null;
  client_points: number | null;
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
         sr.created_at, sr.accepted_at, sr.completed_at, sr.deadline_at,
         CASE WHEN sr.status = 'matched'::request_status THEN (
           SELECT sr.accepted_at + make_interval(mins => q.eta_minutes)
             FROM quotes q
            WHERE q.request_id = sr.id AND q.mechanic_id = sr.mechanic_id AND q.accepted
            LIMIT 1
         ) END AS expected_arrival_at,
         sr.navigating, sr.navigating_at, sr.en_route, sr.en_route_at,
         sr.arrived, sr.arrived_at, sr.work_started, sr.work_started_at,
         sr.service_completed, sr.service_completed_at,
         sr.last_cancel_reason, sr.last_cancelled_by, sr.last_cancelled_at,
         sr.expired_at, sr.expired_by_mechanic,
         sr.agreed_amount::float8 AS agreed_amount, sr.agreed_amount_set_at,
         (p.id IS NOT NULL) AS has_payment,
         p.amount::float8 AS amount_paid, p.platform_fee::float8 AS platform_fee_charged,
         p.fee_paid_with_points::float8 AS fee_paid_with_points,
         p.mechanic_points::float8 AS mechanic_points, p.client_points::float8 AS client_points,
         c.first_name AS c_first, c.last_name AS c_last, c.email AS c_email,
         (sr.mechanic_id IS NOT NULL) AS has_mechanic,
         m.first_name AS m_first, m.last_name AS m_last, m.email AS m_email
    FROM service_requests sr
    JOIN users c ON c.id = sr.client_id
    LEFT JOIN users m ON m.id = sr.mechanic_id
    LEFT JOIN payments p ON p.request_id = sr.id AND p.status = 'completed'::payment_status`;

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
    deadlineAt: iso(row.deadline_at),
    expectedArrivalAt: iso(row.expected_arrival_at),
    mechanicId: row.mechanic_id,
    mechanicName: row.has_mechanic
      ? displayNameOf({ first_name: row.m_first ?? '', last_name: row.m_last ?? '', email: row.m_email ?? '' })
      : null,
    navigating: row.navigating,
    navigatingAt: iso(row.navigating_at),
    enRoute: row.en_route,
    enRouteAt: iso(row.en_route_at),
    arrived: row.arrived,
    arrivedAt: iso(row.arrived_at),
    workStarted: row.work_started,
    workStartedAt: iso(row.work_started_at),
    serviceCompleted: row.service_completed,
    serviceCompletedAt: iso(row.service_completed_at),
    lastCancelReason: row.last_cancel_reason,
    lastCancelledBy: row.last_cancelled_by,
    lastCancelledAt: iso(row.last_cancelled_at),
    expiredAt: iso(row.expired_at),
    expiredByMechanic: row.expired_by_mechanic,
    agreedPaymentAmount: row.agreed_amount,
    agreedPaymentAmountSetAt: iso(row.agreed_amount_set_at),
    paymentCompleted: row.has_payment,
    paymentCompletedAt: row.has_payment ? iso(row.completed_at) : null,
    amountPaid: row.amount_paid,
    platformFeeCharged: row.platform_fee_charged,
    feePaidWithPoints: row.fee_paid_with_points,
    pointsAwarded: row.mechanic_points,
    clientPointsAwarded: row.client_points,
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
  meta: { ipHash: Buffer; requestId: string },
): Promise<ServiceRequestDto[]> {
  const isConsole = auth.role === 'admin' || auth.role === 'moderator';
  const scope = filters.scope ?? 'mine';

  // The open pool is every client's pending job, with that client's name,
  // address and coordinates. It exists for mechanics choosing work and for the
  // console; a client has no reason to browse other clients' requests, so the
  // pool is refused to them and the attempt is logged like any role denial.
  if (scope === 'open' && auth.role !== 'mechanic' && !isConsole) {
    await recordSecurityEvent(db, {
      event: SecurityEvent.AUTHZ_DENIED,
      severity: 'warning',
      actorId: auth.userId,
      actorRole: auth.role,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      metadata: { route: '/service-requests', scope: 'open' },
    });
    throw forbidden('Only mechanics can browse open requests.');
  }

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

/**
 * The client closes a request for good (the app's "Delete"): it becomes
 * `cancelled` and stays as history.
 *
 *   - A pending request can always be cancelled.
 *   - A matched one only as assertClientMayLeaveMatch allows: once the
 *     mechanic's quoted arrival time has passed or they have arrived, and
 *     before work starts. From there the job is finished and paid, not cancelled.
 *
 * The row is locked, so a cancel cannot race an accept, a status step or the
 * expiry sweep.
 */
export async function cancelServiceRequest(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  id: string,
  reason: string | null,
): Promise<ServiceRequestDto> {
  const previous = await db.withTransaction(async (tx) => {
    const req = await lockRequest(tx, id);
    if (!req || req.client_id !== auth.userId) throw notFound('Request not found.');
    if (req.status === 'matched') await assertClientMayLeaveMatch(tx, id, req);
    else if (req.status !== 'pending') throw conflict('This request can no longer be cancelled.');

    await tx.query(
      `UPDATE service_requests
          SET status = 'cancelled'::request_status,
              last_cancel_reason = $2, last_cancelled_by = $3, last_cancelled_at = now()
        WHERE id = $1`,
      [id, reason?.trim() || null, auth.displayName],
    );
    return req.status;
  });

  const row = await fetchRequest(db, id);
  if (!row) throw new Error('request vanished after cancel');
  const dto = toDto(row);
  // A pending request was in the open pool, so mechanics hear it is gone; a
  // matched one concerns only its client and mechanic.
  const audience =
    previous === 'pending' ? { roles: MECHANIC_AUDIENCE, userIds: [auth.userId] } : { userIds: parties(dto) };
  await events.publish({ name: SERVICE_REQUEST_UPDATED, data: dto, audience });
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
    const req = await tx.queryOne<{ client_id: string; status: RequestStatusName; urgency: UrgencyName }>(
      `SELECT client_id, status::text AS status, urgency::text AS urgency FROM service_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    if (!req || req.client_id !== auth.userId) throw notFound('Request not found.');
    if (req.status !== 'pending') throw conflict('This request has already been matched or closed.');
    // An Emergency is taken by a mechanic directly; its only "quote" is that
    // mechanic's accept record, which is never the client's to accept.
    if (req.urgency === 'Emergency') throw conflict('An Emergency is accepted by a mechanic, not by the client.');

    const q = await tx.queryOne<{ id: string; mechanic_id: string; withdrawn_at: Date | null; rejected_at: Date | null }>(
      `SELECT id, mechanic_id, withdrawn_at, rejected_at FROM quotes WHERE id = $1 AND request_id = $2 FOR UPDATE`,
      [quoteId, requestId],
    );
    if (!q || q.withdrawn_at || q.rejected_at) throw notFound('That quote is not available to accept.');

    // Matching starts the completion clock and clears why a previous match
    // came apart.
    await tx.query(
      `UPDATE service_requests
          SET status = 'matched'::request_status, mechanic_id = $2, accepted_at = now(),
              deadline_at = now() + make_interval(mins => $3::int),
              expired_at = NULL, expired_by_mechanic = NULL,
              last_cancel_reason = NULL, last_cancelled_by = NULL, last_cancelled_at = NULL
        WHERE id = $1 AND status = 'pending'::request_status`,
      [requestId, q.mechanic_id, WINDOW_MINUTES[req.urgency] ?? null],
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
        `UPDATE service_requests
            SET status = 'matched'::request_status, mechanic_id = $2, accepted_at = now(),
                deadline_at = now() + make_interval(mins => $3::int),
                expired_at = NULL, expired_by_mechanic = NULL,
                last_cancel_reason = NULL, last_cancelled_by = NULL, last_cancelled_at = NULL
          WHERE id = $1 AND status = 'pending'::request_status`,
        [requestId, auth.userId, windowMinutes],
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

// ─── Slice 4: the service-status machine ────────────────────────────────────

export type StatusStep = 'navigating' | 'en_route' | 'arrived' | 'work_started' | 'service_completed';

/**
 * The assigned mechanic advances a matched job one stage. Each step is
 * idempotent (repeating it keeps the first timestamp) and gated: work needs
 * arrival, service-complete needs work. The request row is locked so a status
 * change cannot race a cancel or expiry. `service_completed` leaves the request
 * matched — payment (slice 5) is what closes it.
 */
export async function advanceJobStatus(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  requestId: string,
  step: StatusStep,
): Promise<ServiceRequestDto> {
  await db.withTransaction(async (tx) => {
    const row = await tx.queryOne<{ mechanic_id: string | null; status: RequestStatusName; arrived: boolean; work_started: boolean }>(
      `SELECT mechanic_id, status::text AS status, arrived, work_started
         FROM service_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    if (!row || row.mechanic_id !== auth.userId) throw notFound('Request not found.');
    if (row.status !== 'matched') throw conflict('This job is not in progress.');

    switch (step) {
      case 'navigating':
        await tx.query(`UPDATE service_requests SET navigating = true, navigating_at = COALESCE(navigating_at, now()) WHERE id = $1`, [requestId]);
        break;
      case 'en_route':
        await tx.query(`UPDATE service_requests SET en_route = true, en_route_at = COALESCE(en_route_at, now()) WHERE id = $1`, [requestId]);
        break;
      case 'arrived':
        // Arriving implies being en route, so backfill it.
        await tx.query(
          `UPDATE service_requests
              SET arrived = true, arrived_at = COALESCE(arrived_at, now()),
                  en_route = true, en_route_at = COALESCE(en_route_at, now())
            WHERE id = $1`,
          [requestId],
        );
        break;
      case 'work_started':
        if (!row.arrived) throw conflict('Mark yourself arrived before starting work.');
        await tx.query(`UPDATE service_requests SET work_started = true, work_started_at = COALESCE(work_started_at, now()) WHERE id = $1`, [requestId]);
        break;
      case 'service_completed':
        if (!row.work_started) throw conflict('Start the work before completing the service.');
        await tx.query(`UPDATE service_requests SET service_completed = true, service_completed_at = COALESCE(service_completed_at, now()) WHERE id = $1`, [requestId]);
        break;
    }
  });

  const row = await fetchRequest(db, requestId);
  if (!row) throw new Error('request vanished after status change');
  const dto = toDto(row);
  await events.publish({ name: SERVICE_REQUEST_UPDATED, data: dto, audience: { userIds: parties(dto) } });
  return dto;
}

// ─── Slice 5: payment (the client pays; the job closes) ─────────────────────

export const PAYMENT_COMPLETED = 'payment.completed';

const ADMIN_AUDIENCE = ['admin'] as const;

/**
 * EMERGENCY ONLY. An emergency skips quoting, so the assigned mechanic records
 * the price agreed with the client in person, and may correct it until the job
 * is paid. Normal and Urgent jobs are always paid their accepted quote's price.
 */
export async function setAgreedAmount(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  requestId: string,
  amount: number,
): Promise<ServiceRequestDto> {
  await db.withTransaction(async (tx) => {
    const row = await tx.queryOne<{ mechanic_id: string | null; status: RequestStatusName; urgency: UrgencyName }>(
      `SELECT mechanic_id, status::text AS status, urgency::text AS urgency
         FROM service_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    if (!row || row.mechanic_id !== auth.userId) throw notFound('Request not found.');
    if (row.urgency !== 'Emergency') {
      throw conflict('Normal and Urgent jobs are paid their quoted price; only an Emergency takes an agreed amount.');
    }
    if (row.status !== 'matched') throw conflict('This job is not in progress.');
    await tx.query(
      `UPDATE service_requests SET agreed_amount = round($2::numeric, 2), agreed_amount_set_at = now() WHERE id = $1`,
      [requestId, amount],
    );
  });

  const row = await fetchRequest(db, requestId);
  if (!row) throw new Error('request vanished after setting the agreed amount');
  const dto = toDto(row);
  await events.publish({ name: SERVICE_REQUEST_UPDATED, data: dto, audience: { userIds: parties(dto) } });
  return dto;
}

/**
 * The client pays for a finished job, which is what closes it. Money and points
 * are settled here in one transaction from the server's own records, never from
 * a figure the phone sends:
 *
 *   - the mechanic's amount: the accepted quote's price, or the agreed amount on
 *     an Emergency. `expectedAmount`, when sent, must match it, so a client is
 *     never charged a figure that changed after they looked;
 *   - ONGO's priority fee: the surcharge fixed on the request at booking,
 *     optionally paid with the client's points at 1 pt = ₱1 when their balance
 *     covers it. A short balance leaves the fee charged in pesos, never waived;
 *   - points: the client's for the job's urgency and the mechanic's per peso of
 *     payout, from the points policy in force now. The fee spend is checked
 *     before this job's points are credited, so they cannot pay its own fee.
 *
 * Idempotent: paying a job that is already paid returns it unchanged, and the
 * partial unique indexes on payments and points_ledger turn a racing second pay
 * into a rollback rather than a second booking.
 */
export async function payForJob(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  requestId: string,
  input: { payFeeWithPoints?: boolean; expectedAmount?: number },
): Promise<ServiceRequestDto> {
  let paidNow = false;
  let raced: unknown = null;
  try {
    paidNow = await db.withTransaction(async (tx) => {
      const req = await tx.queryOne<{
        client_id: string;
        mechanic_id: string | null;
        status: RequestStatusName;
        urgency: UrgencyName;
        issue: string;
        surcharge: number;
        service_completed: boolean;
        agreed_amount: string | null;
      }>(
        `SELECT client_id, mechanic_id, status::text AS status, urgency::text AS urgency, issue,
                surcharge, service_completed, agreed_amount::text AS agreed_amount
           FROM service_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      if (!req || req.client_id !== auth.userId) throw notFound('Request not found.');
      if (req.status === 'completed') return false;
      const mechanicId = req.mechanic_id;
      if (req.status !== 'matched' || mechanicId === null) throw conflict('This job is not in progress.');
      if (!req.service_completed) throw conflict('The mechanic has not marked the service complete yet.');

      let amount: string;
      if (req.urgency === 'Emergency') {
        if (req.agreed_amount === null) throw conflict('The mechanic has not set the agreed amount yet.');
        amount = req.agreed_amount;
      } else {
        const quote = await tx.queryOne<{ price: string }>(
          `SELECT price::text AS price FROM quotes WHERE request_id = $1 AND mechanic_id = $2 AND accepted = true`,
          [requestId, mechanicId],
        );
        if (!quote) throw conflict('This job has no accepted quote to pay.');
        amount = quote.price;
      }
      if (
        input.expectedAmount !== undefined &&
        Math.round(input.expectedAmount * 100) !== Math.round(Number(amount) * 100)
      ) {
        throw conflict('The amount to pay has changed. Review it and pay again.');
      }

      const fee = req.surcharge;
      let feePaidWithPoints: number | null = null;
      if (input.payFeeWithPoints === true && fee > 0) {
        // Serialize this client's points movements, so two spends cannot both
        // pass the balance check.
        await tx.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [auth.userId]);
        const covered = await tx.queryOne<{ enough: boolean }>(
          `SELECT COALESCE(SUM(points), 0) >= $2::numeric AS enough FROM points_ledger WHERE user_id = $1`,
          [auth.userId, fee],
        );
        if (covered?.enough === true) {
          await tx.query(
            `INSERT INTO points_ledger (user_id, kind, points, pesos, note, request_id)
             VALUES ($1, 'clientPaidSurcharge'::points_entry_kind, $2::numeric, $3::numeric, $4, $5)`,
            [auth.userId, -fee, fee, `${req.urgency} priority fee · ${req.issue}`, requestId],
          );
          feePaidWithPoints = fee;
        }
      }

      const payment = await tx.queryOne<{ client_points: string; mechanic_points: string }>(
        `INSERT INTO payments
           (request_id, client_id, mechanic_id, amount, platform_fee, status, idempotency_key,
            completed_at, fee_paid_with_points, client_points, mechanic_points)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, 'completed'::payment_status, $6,
                 now(), $7::numeric,
                 (SELECT CASE $8::text WHEN 'Emergency' THEN client_emergency
                                       WHEN 'Urgent' THEN client_urgent
                                       ELSE client_normal END
                    FROM points_policy WHERE id = 1),
                 (SELECT CASE WHEN $4::numeric > 0 THEN round($4::numeric * mechanic_per_peso, 2) ELSE 0 END
                    FROM points_policy WHERE id = 1))
         RETURNING client_points::text AS client_points, mechanic_points::text AS mechanic_points`,
        [requestId, auth.userId, mechanicId, amount, fee, requestId, feePaidWithPoints, req.urgency],
      );
      if (!payment) throw new Error('payment insert produced no row');

      await tx.query(
        `UPDATE service_requests SET status = 'completed'::request_status, completed_at = now()
          WHERE id = $1 AND status = 'matched'::request_status`,
        [requestId],
      );

      if (Number(payment.client_points) > 0) {
        await tx.query(
          `INSERT INTO points_ledger (user_id, kind, points, note, request_id)
           VALUES ($1, 'clientJobCompleted'::points_entry_kind, $2::numeric, $3, $4)`,
          [auth.userId, payment.client_points, `${req.urgency} job · ${req.issue}`, requestId],
        );
      }
      if (Number(payment.mechanic_points) > 0) {
        await tx.query(
          `INSERT INTO points_ledger (user_id, kind, points, note, request_id)
           VALUES ($1, 'mechanicJobCompleted'::points_entry_kind, $2::numeric, $3, $4)`,
          [mechanicId, payment.mechanic_points, req.issue, requestId],
        );
      }
      return true;
    });
  } catch (err) {
    // A racing second pay that lost to a partial unique index: the first one
    // settled the job, so answer with that (checked below).
    if (!isUniqueViolation(err)) throw err;
    raced = err;
  }

  const row = await fetchRequest(db, requestId);
  if (!row || row.client_id !== auth.userId) throw notFound('Request not found.');
  const dto = toDto(row);
  if (raced !== null && !dto.paymentCompleted) throw raced;

  if (paidNow) {
    await events.publish({ name: SERVICE_REQUEST_UPDATED, data: dto, audience: { userIds: parties(dto) } });
    await events.publish({
      name: PAYMENT_COMPLETED,
      data: { requestId: dto.id, urgency: dto.urgency, platformFee: dto.platformFeeCharged ?? 0, paidAt: dto.paymentCompletedAt },
      audience: { roles: ADMIN_AUDIENCE },
    });
  }
  return dto;
}

// ─── Slice 6: cancel and expiry (a match comes apart) ───────────────────────

const EXPIRED_REASON = 'Did not complete the job within the allowed time.';

interface LockedRequest {
  client_id: string;
  mechanic_id: string | null;
  status: RequestStatusName;
  urgency: UrgencyName;
  navigating: boolean;
  en_route: boolean;
  arrived: boolean;
  work_started: boolean;
}

function lockRequest(tx: Queryable, id: string): Promise<LockedRequest | null> {
  return tx.queryOne<LockedRequest>(
    `SELECT client_id, mechanic_id, status::text AS status, urgency::text AS urgency,
            navigating, en_route, arrived, work_started
       FROM service_requests WHERE id = $1 FOR UPDATE`,
    [id],
  );
}

/**
 * The ETA lock, and the line after which a job is finished rather than
 * cancelled. On a matched job the client may let the mechanic go only once the
 * arrival time they quoted has passed, or they have arrived, and only before
 * work starts. Throws on refusal and writes nothing.
 */
async function assertClientMayLeaveMatch(tx: Queryable, id: string, req: LockedRequest): Promise<void> {
  if (req.work_started) throw conflict('Work has started on this job, so it can no longer be cancelled.');
  if (req.arrived) return;
  const eta = await tx.queryOne<{ due: Date; locked: boolean }>(
    `SELECT sr.accepted_at + make_interval(mins => q.eta_minutes) AS due,
            sr.accepted_at + make_interval(mins => q.eta_minutes) > now() AS locked
       FROM service_requests sr
       JOIN quotes q ON q.request_id = sr.id AND q.mechanic_id = sr.mechanic_id AND q.accepted
      WHERE sr.id = $1`,
    [id],
  );
  if (eta?.locked === true) {
    throw new AppError('conflict', 'Your mechanic is still within the arrival time they promised. You can cancel once it passes.', {
      details: { cancellableAt: eta.due.toISOString() },
    });
  }
}

/**
 * Puts a matched job back in the open pool: the mechanic is released, every
 * progress step and an Emergency's agreed amount are cleared, and no quote is
 * accepted any more. `withdrawMechanicQuote` also takes the released mechanic's
 * own quote off the table: an Emergency accept record, or a mechanic who backed
 * out. The stamps say why, for the client's Jobs screen.
 */
async function returnToPool(
  tx: Queryable,
  id: string,
  mechanicId: string,
  why: { withdrawMechanicQuote: boolean; reason: string | null; by: string | null; expired: boolean },
): Promise<void> {
  await tx.query(
    `UPDATE quotes
        SET accepted = false,
            withdrawn_at = CASE WHEN $3::boolean AND mechanic_id = $2 THEN COALESCE(withdrawn_at, now())
                                ELSE withdrawn_at END
      WHERE request_id = $1`,
    [id, mechanicId, why.withdrawMechanicQuote],
  );
  await tx.query(
    `UPDATE service_requests
        SET status = 'pending'::request_status, mechanic_id = NULL, accepted_at = NULL, deadline_at = NULL,
            navigating = false, navigating_at = NULL, en_route = false, en_route_at = NULL,
            arrived = false, arrived_at = NULL, work_started = false, work_started_at = NULL,
            service_completed = false, service_completed_at = NULL,
            agreed_amount = NULL, agreed_amount_set_at = NULL,
            last_cancel_reason = $2, last_cancelled_by = $3,
            last_cancelled_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,
            expired_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
            expired_by_mechanic = CASE WHEN $4::boolean THEN $3::text ELSE NULL END
      WHERE id = $1 AND status = 'matched'::request_status`,
    [id, why.reason, why.by, why.expired],
  );
}

/** A job back in the open pool concerns its client, the released mechanic, and every mechanic browsing the pool. */
async function publishReturnedToPool(
  db: Queryable,
  events: EventBus,
  id: string,
  releasedMechanicId: string,
): Promise<ServiceRequestDto> {
  const row = await fetchRequest(db, id);
  if (!row) throw new Error('request vanished after returning to the pool');
  const dto = toDto(row);
  await events.publish({
    name: SERVICE_REQUEST_UPDATED,
    data: dto,
    audience: { roles: MECHANIC_AUDIENCE, userIds: [dto.clientId, releasedMechanicId] },
  });
  return dto;
}

/**
 * The client puts a matched job back in the open pool (the app's "Revert to
 * Pending"), under the same ETA lock as cancelling. The mechanic is released and
 * their quote stays on the table, for the client to accept again or reject;
 * an Emergency's accept record is withdrawn instead.
 */
export async function reopenServiceRequest(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  id: string,
): Promise<ServiceRequestDto> {
  const released = await db.withTransaction(async (tx) => {
    const req = await lockRequest(tx, id);
    if (!req || req.client_id !== auth.userId) throw notFound('Request not found.');
    if (req.status !== 'matched' || req.mechanic_id === null) {
      throw conflict('Only a matched job can be put back in the open pool.');
    }
    await assertClientMayLeaveMatch(tx, id, req);
    await returnToPool(tx, id, req.mechanic_id, {
      withdrawMechanicQuote: req.urgency === 'Emergency',
      reason: null,
      by: null,
      expired: false,
    });
    return req.mechanic_id;
  });
  return publishReturnedToPool(db, events, id, released);
}

/**
 * The assigned mechanic backs out of a matched job, with a reason the client is
 * shown. Only before setting off, meaning no progress step taken, and never on
 * an Emergency, which the mechanic claimed first-come. The job returns to the
 * open pool and the mechanic's quote is withdrawn: the client is not offered the
 * same mechanic again unless they quote afresh.
 */
export async function mechanicCancelJob(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  id: string,
  reason: string,
): Promise<ServiceRequestDto> {
  const why = reason.trim();
  if (why.length === 0) throw badRequest('Tell the client why you are cancelling.');

  await db.withTransaction(async (tx) => {
    const req = await lockRequest(tx, id);
    if (!req || req.mechanic_id !== auth.userId) throw notFound('Request not found.');
    if (req.status !== 'matched') throw conflict('This job is not in progress.');
    if (req.urgency === 'Emergency') throw conflict('An accepted Emergency cannot be cancelled.');
    if (req.navigating || req.en_route || req.arrived || req.work_started) {
      throw conflict('You are already on your way to this job, so it can no longer be cancelled.');
    }
    await returnToPool(tx, id, auth.userId, { withdrawMechanicQuote: true, reason: why, by: auth.displayName, expired: false });
  });
  return publishReturnedToPool(db, events, id, auth.userId);
}

/**
 * The completion clock. An Urgent or Emergency job still not under way at its
 * deadline goes back to the open pool, stamped with who let it lapse, as the
 * mobile app's sweep did. Normal jobs have no deadline and never expire, and
 * once work starts the clock stops for good.
 *
 * Safe to run as often as needed, from any number of instances: the due rows
 * are locked in id order and re-checked under the lock, so each job expires
 * once. Every jobs route runs it first and bootstrap.ts runs it on a timer; it
 * costs one indexed read when nothing is due. Returns how many jobs expired.
 */
export async function expireOverdueJobs(db: Database, events: EventBus): Promise<number> {
  const due = await db.queryOne<{ due: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM service_requests
        WHERE status = 'matched'::request_status AND work_started = false AND deadline_at <= now()
     ) AS due`,
  );
  if (due?.due !== true) return 0;

  const expired = await db.withTransaction(async (tx) => {
    const rows = await tx.query<{ id: string; mechanic_id: string; urgency: UrgencyName; m_first: string; m_last: string; m_email: string }>(
      `SELECT sr.id, sr.mechanic_id, sr.urgency::text AS urgency,
              m.first_name AS m_first, m.last_name AS m_last, m.email AS m_email
         FROM service_requests sr
         JOIN users m ON m.id = sr.mechanic_id
        WHERE sr.status = 'matched'::request_status AND sr.work_started = false AND sr.deadline_at <= now()
        ORDER BY sr.id
          FOR UPDATE OF sr`,
    );
    for (const row of rows) {
      await returnToPool(tx, row.id, row.mechanic_id, {
        withdrawMechanicQuote: row.urgency === 'Emergency',
        reason: EXPIRED_REASON,
        by: displayNameOf({ first_name: row.m_first, last_name: row.m_last, email: row.m_email }),
        expired: true,
      });
    }
    return rows;
  });

  for (const row of expired) {
    await publishReturnedToPool(db, events, row.id, row.mechanic_id);
  }
  return expired.length;
}
