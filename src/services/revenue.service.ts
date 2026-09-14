import type { AuthContext } from '../auth/guard.js';
import type { Queryable } from '../db/database.js';

/**
 * Platform revenue.
 *
 * The mobile app reports a completed client payment; the console reads the
 * ledger back as months split by urgency. Normal jobs carry no priority fee,
 * so their revenue is legitimately zero while their transaction count is the
 * largest — which is why volume and revenue are reported separately.
 */

export type RevenueUrgency = 'normal' | 'urgent' | 'emergency';

const TO_DB: Record<RevenueUrgency, string> = {
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

/** Idempotent: a retried report of the same request books nothing twice. */
export async function reportCompletedPayment(
  db: Queryable,
  auth: AuthContext,
  report: CompletedPaymentReportDto,
): Promise<{ recorded: boolean }> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO revenue_ledger (request_ref, platform_fee, urgency, paid_at, reported_by)
     VALUES ($1, $2::numeric, $3::urgency_level, $4::timestamptz, $5)
     ON CONFLICT (request_ref) DO NOTHING
     RETURNING id`,
    [report.requestId, report.platformFee, TO_DB[report.urgency ?? 'normal'], report.paidAt, auth.userId],
  );
  return { recorded: rows.length > 0 };
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
    `SELECT date_part('year',  paid_at AT TIME ZONE $1)::int AS year,
            date_part('month', paid_at AT TIME ZONE $1)::int AS month,
            urgency::text                                     AS urgency,
            SUM(platform_fee)::float8                         AS revenue,
            COUNT(*)::int                                     AS transactions
       FROM revenue_ledger
      GROUP BY 1, 2, 3
      ORDER BY 1, 2`,
    [timezone],
  );

  const fees = await db.queryOne<{ revenue: number; count: number }>(
    `SELECT COALESCE(SUM(platform_fee), 0)::float8 AS revenue, COUNT(*)::int AS count
       FROM revenue_ledger WHERE platform_fee > 0`,
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
