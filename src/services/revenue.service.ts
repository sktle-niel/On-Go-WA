import type { AuthContext } from '../auth/guard.js';
import type { Queryable } from '../db/database.js';
import { notFound } from '../utils/errors.js';

/**
 * Platform revenue.
 *
 * Revenue is ONGO's priority fee on every completed payment, and payments are
 * settled by the server when a client pays for a job (payForJob in
 * jobs.service.ts). The console reads them back as months split by urgency.
 * Normal jobs carry no priority fee, so their revenue is legitimately zero
 * while their transaction count is the largest — which is why volume and
 * revenue are reported separately.
 *
 * The old revenue_ledger, which booked whatever fee the phone reported, is
 * retired (migration 010): nothing reads or writes it.
 */

export type RevenueUrgency = 'normal' | 'urgent' | 'emergency';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PlatformRevenueApi.reportCompletedPayment, kept so the contract still has its
 * route. It books NOTHING: revenue is settled by the server when the client
 * pays. The report is acknowledged only for a job the caller took part in that
 * has a completed payment; the fee, urgency and time in the body are ignored,
 * so a retry is harmless and an invented fee cannot move the figures.
 */
export async function acknowledgeReportedPayment(
  db: Queryable,
  auth: AuthContext,
  report: CompletedPaymentReportDto,
): Promise<void> {
  const missing = () => notFound('No completed payment for that request.');
  if (!UUID.test(report.requestId)) throw missing();
  const row = await db.queryOne<{ paid: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM payments
        WHERE request_id = $1 AND status = 'completed'::payment_status
          AND (client_id = $2 OR mechanic_id = $2)
     ) AS paid`,
    [report.requestId, auth.userId],
  );
  if (row?.paid !== true) throw missing();
}

interface BucketRow {
  year: number;
  month: number;
  urgency: string;
  revenue: number;
  transactions: number;
}

export async function revenueSummary(db: Queryable, timezone: string): Promise<PlatformRevenueSummaryDto> {
  const buckets = await db.query<BucketRow>(
    `SELECT date_part('year',  p.completed_at AT TIME ZONE $1)::int AS year,
            date_part('month', p.completed_at AT TIME ZONE $1)::int AS month,
            sr.urgency::text                                     AS urgency,
            SUM(p.platform_fee)::float8                         AS revenue,
            COUNT(*)::int                                     AS transactions
       FROM payments p
       JOIN service_requests sr ON sr.id = p.request_id
      WHERE p.status = 'completed'::payment_status
      GROUP BY 1, 2, 3
      ORDER BY 1, 2`,
    [timezone],
  );

  const fees = await db.queryOne<{ revenue: number; count: number }>(
    `SELECT COALESCE(SUM(platform_fee), 0)::float8 AS revenue, COUNT(*)::int AS count
       FROM payments WHERE status = 'completed'::payment_status AND platform_fee > 0`,
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
