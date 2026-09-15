import type { AuthContext } from '../auth/guard.js';
import type { Database, Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import { recordSecurityEvent, SecurityEvent } from '../logging/audit.js';
import { conflict } from '../utils/errors.js';

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

// ─── The points wallet ──────────────────────────────────────────────────────
//
// Every point anyone holds is a signed row in points_ledger; a balance is the
// sum of a user's rows, so it cannot drift from the history that explains it.
// Points are earned when a job is paid (payForJob in jobs.service.ts) and spent
// there on a priority fee, or here when a mechanic converts them to balance.

export type PointsEntryKindName =
  | 'clientJobCompleted'
  | 'mechanicJobCompleted'
  | 'clientPaidSurcharge'
  | 'mechanicConvertedToBalance';

export interface PointsEntryDto {
  id: string;
  kind: PointsEntryKindName;
  points: number;
  pesos: number | null;
  note: string;
  requestId: string | null;
  at: string;
}

export interface PointsWalletDto {
  balance: number;
  earnings: number;
  convertedPesos: number;
  availableBalance: number;
  entries: PointsEntryDto[];
}

const WALLET_ENTRY_LIMIT = 200;

export async function getWallet(db: Queryable, auth: AuthContext): Promise<PointsWalletDto> {
  const totals = await db.queryOne<{ balance: number; converted: number; earnings: number; available: number }>(
    `WITH t AS (
       SELECT (SELECT COALESCE(SUM(points), 0) FROM points_ledger WHERE user_id = $1) AS balance,
              (SELECT COALESCE(SUM(pesos), 0) FROM points_ledger
                WHERE user_id = $1 AND kind = 'mechanicConvertedToBalance'::points_entry_kind) AS converted,
              (SELECT COALESCE(SUM(amount), 0) FROM payments
                WHERE mechanic_id = $1 AND status = 'completed'::payment_status) AS earnings
     )
     SELECT balance::float8 AS balance, converted::float8 AS converted, earnings::float8 AS earnings,
            (earnings + converted)::float8 AS available
       FROM t`,
    [auth.userId],
  );
  const rows = await db.query<{
    id: string;
    kind: PointsEntryKindName;
    points: number;
    pesos: number | null;
    note: string;
    request_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, kind::text AS kind, points::float8 AS points, pesos::float8 AS pesos, note, request_id, created_at
       FROM points_ledger
      WHERE user_id = $1
      ORDER BY created_at DESC, id
      LIMIT $2`,
    [auth.userId, WALLET_ENTRY_LIMIT],
  );
  return {
    balance: totals?.balance ?? 0,
    earnings: totals?.earnings ?? 0,
    convertedPesos: totals?.converted ?? 0,
    availableBalance: totals?.available ?? 0,
    entries: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      points: row.points,
      pesos: row.pesos,
      note: row.note,
      requestId: row.request_id,
      at: row.created_at.toISOString(),
    })),
  };
}

/**
 * A mechanic turns points into account balance at 1 pt = ₱1. The user row is
 * locked first, so two conversions cannot both pass the balance check.
 */
export async function convertPointsToBalance(
  db: Database,
  auth: AuthContext,
  points: number,
): Promise<PointsWalletDto> {
  await db.withTransaction(async (tx) => {
    await tx.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [auth.userId]);
    const check = await tx.queryOne<{ amount: string; enough: boolean }>(
      `SELECT round($2::numeric, 2)::text AS amount,
              COALESCE(SUM(points), 0) >= round($2::numeric, 2) AS enough
         FROM points_ledger WHERE user_id = $1`,
      [auth.userId, points],
    );
    if (!check || !check.enough) throw conflict('You do not have that many points.');
    await tx.query(
      `INSERT INTO points_ledger (user_id, kind, points, pesos, note)
       VALUES ($1, 'mechanicConvertedToBalance'::points_entry_kind, -($2::numeric), $2::numeric, $3)`,
      [auth.userId, check.amount, `Converted to ₱${check.amount} balance`],
    );
  });
  return getWallet(db, auth);
}
