import type { AuthContext } from '../auth/guard.js';
import type { Queryable } from '../db/database.js';
import { recordSecurityEvent, SecurityEvent } from '../logging/audit.js';
import { AppError, badRequest, forbidden, notFound } from '../utils/errors.js';
import { SURCHARGE } from './jobs.service.js';

/**
 * Platform revenue.
 *
 * Revenue is ONGO's priority fee on every completed payment. It comes from two
 * places, read together:
 *
 *   - payments the server settles when a client pays for a job it holds
 *     (payForJob in jobs.service.ts);
 *   - during a compatibility window, payments a mobile build that still settles
 *     jobs on the device reports to POST /payments, kept in revenue_ledger.
 *
 * A job is in one place or the other, never both, so nothing is counted twice.
 * The console reads them back as months split by urgency. Normal jobs carry no
 * priority fee, so their revenue is legitimately zero while their transaction
 * count is the largest — which is why volume and revenue are reported
 * separately.
 */

export type RevenueUrgency = 'normal' | 'urgent' | 'emergency';

const TO_DB: Record<RevenueUrgency, 'Normal' | 'Urgent' | 'Emergency'> = {
  normal: 'Normal',
  urgent: 'Urgent',
  emergency: 'Emergency',
};

const FROM_DB: Record<string, RevenueUrgency> = {
  Normal: 'normal',
  Urgent: 'urgent',
  Emergency: 'emergency',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface CompletedPaymentReportDto {
  requestId: string;
  platformFee: number;
  paidAt: string;
  urgency?: RevenueUrgency;
}

export interface UrgencyTotalsDto {
  revenue: number;
  transactions: number;
}

export interface MonthlyIncomeDto {
  month: string;
  year: number;
  revenue: number;
  transactions: number;
  byUrgency: Record<RevenueUrgency, UrgencyTotalsDto>;
}

export interface PlatformRevenueSummaryDto {
  months: MonthlyIncomeDto[];
  priorityFeeRevenue: number;
  priorityFeeCount: number;
}

export interface ReportMeta {
  ipHash: Buffer;
  requestId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How far ahead of the server clock a reported payment may be stamped. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** The oldest payment a device may still report; its retries do not outlive a week. */
const MAX_REPORT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Device reports one client may book in a day. Nobody settles more jobs than this. */
export const LEGACY_REPORTS_PER_DAY = 20;

/**
 * PlatformRevenueApi.reportCompletedPayment.
 *
 *   - A job the server holds is paid through POST /service-requests/:id/pay,
 *     which books its revenue. Reporting it books nothing: 204 for a paid job
 *     the caller took part in, 404 otherwise.
 *   - A job the server does not hold comes from a mobile build that still
 *     settles jobs on the device. While `legacyReports` is on, the client who
 *     paid books it into revenue_ledger once per job id, and only with the
 *     priority fee its urgency carries, a paidAt from the last week, and at
 *     most LEGACY_REPORTS_PER_DAY a day. The old route took any fee on trust;
 *     these checks keep the window from being a way to invent revenue.
 */
export async function reportCompletedPayment(
  db: Queryable,
  auth: AuthContext,
  report: CompletedPaymentReportDto,
  options: { legacyReports: boolean; meta: ReportMeta },
): Promise<void> {
  const missing = () => notFound('No completed payment for that request.');

  if (UUID.test(report.requestId)) {
    const job = await db.queryOne<{ paid: boolean; party: boolean }>(
      `SELECT EXISTS (
                SELECT 1 FROM payments p
                 WHERE p.request_id = sr.id AND p.status = 'completed'::payment_status
              ) AS paid,
              (sr.client_id = $2::uuid OR sr.mechanic_id = $2::uuid) AS party
         FROM service_requests sr
        WHERE sr.id = $1`,
      [report.requestId, auth.userId],
    );
    if (job) {
      if (job.paid && job.party) return;
      throw missing();
    }
  }

  if (!options.legacyReports) throw missing();
  if (auth.role !== 'client') throw forbidden('Only the client who paid reports a payment.');

  const urgency = report.urgency ?? 'normal';
  const fee = SURCHARGE[TO_DB[urgency]];
  const logRefusal = (reason: string) =>
    recordSecurityEvent(db, {
      event: SecurityEvent.VALIDATION_REJECTED,
      severity: 'notice',
      actorId: auth.userId,
      actorRole: auth.role,
      targetType: 'payment_report',
      ipHash: options.meta.ipHash,
      requestId: options.meta.requestId,
      metadata: { reason, urgency },
    });

  if (report.platformFee !== fee) {
    await logRefusal('fee_mismatch');
    throw badRequest(`The priority fee for a ${urgency} job is ₱${fee}.`);
  }
  const paidAt = Date.parse(report.paidAt);
  const now = Date.now();
  if (paidAt > now + MAX_FUTURE_SKEW_MS) throw badRequest('paidAt is ahead of the server clock.');
  if (paidAt < now - MAX_REPORT_AGE_MS) throw badRequest('That payment is too old to report.');

  // A retry, or the same job id reported twice: booked once either way.
  const existing = await db.queryOne<{ id: string }>(`SELECT id FROM revenue_ledger WHERE request_ref = $1`, [
    report.requestId,
  ]);
  if (existing) return;

  const today = await db.queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM revenue_ledger
      WHERE reported_by = $1 AND created_at > now() - interval '1 day'`,
    [auth.userId],
  );
  if ((today?.n ?? 0) >= LEGACY_REPORTS_PER_DAY) {
    await logRefusal('daily_cap');
    throw new AppError('rate_limited', 'Too many payment reports from this account today. Try again tomorrow.');
  }

  await db.query(
    `INSERT INTO revenue_ledger (request_ref, platform_fee, urgency, paid_at, reported_by)
     VALUES ($1, $2::numeric, $3::urgency_level, $4::timestamptz, $5)
     ON CONFLICT (request_ref) DO NOTHING`,
    [report.requestId, fee, TO_DB[urgency], report.paidAt, auth.userId],
  );
}

interface BucketRow {
  year: number;
  month: number;
  urgency: string;
  revenue: number;
  transactions: number;
}

/** Every completed payment: settled by the server, or reported by a device during the compatibility window. */
const SETTLED_PAYMENTS = `
  WITH settled AS (
    SELECT p.completed_at AS paid_at, sr.urgency, p.platform_fee
      FROM payments p
      JOIN service_requests sr ON sr.id = p.request_id
     WHERE p.status = 'completed'::payment_status
    UNION ALL
    SELECT rl.paid_at, rl.urgency, rl.platform_fee
      FROM revenue_ledger rl
  )`;

export async function revenueSummary(db: Queryable, timezone: string): Promise<PlatformRevenueSummaryDto> {
  const buckets = await db.query<BucketRow>(
    `${SETTLED_PAYMENTS}
     SELECT date_part('year',  paid_at AT TIME ZONE $1)::int AS year,
            date_part('month', paid_at AT TIME ZONE $1)::int AS month,
            urgency::text                                    AS urgency,
            SUM(platform_fee)::float8                        AS revenue,
            COUNT(*)::int                                    AS transactions
       FROM settled
      GROUP BY 1, 2, 3
      ORDER BY 1, 2`,
    [timezone],
  );

  const fees = await db.queryOne<{ revenue: number; count: number }>(
    `${SETTLED_PAYMENTS}
     SELECT COALESCE(SUM(platform_fee), 0)::float8 AS revenue, COUNT(*)::int AS count
       FROM settled WHERE platform_fee > 0`,
  );

  const months = new Map<string, MonthlyIncomeDto>();
  for (const bucket of buckets) {
    const key = `${bucket.year}-${bucket.month}`;
    let entry = months.get(key);
    if (!entry) {
      entry = {
        month: MONTHS[bucket.month - 1] ?? String(bucket.month),
        year: bucket.year,
        revenue: 0,
        transactions: 0,
        byUrgency: {
          normal: { revenue: 0, transactions: 0 },
          urgent: { revenue: 0, transactions: 0 },
          emergency: { revenue: 0, transactions: 0 },
        },
      };
      months.set(key, entry);
    }
    const urgency = FROM_DB[bucket.urgency] ?? 'normal';
    entry.byUrgency[urgency] = { revenue: bucket.revenue, transactions: bucket.transactions };
    entry.revenue += bucket.revenue;
    entry.transactions += bucket.transactions;
  }

  return {
    months: [...months.values()],
    priorityFeeRevenue: fees?.revenue ?? 0,
    priorityFeeCount: fees?.count ?? 0,
  };
}
