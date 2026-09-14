import type { AuthContext } from '../auth/guard.js';
import { displayNameOf } from '../auth/users.js';
import type { Database, Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import { recordSecurityEvent, SecurityEvent } from '../logging/audit.js';
import { AppError, conflict, forbidden, isUniqueViolation, notFound } from '../utils/errors.js';

/**
 * Account verification — the mobile → console → mobile round trip.
 *
 * A mechanic files a request; a moderator or admin decides it; the mobile app
 * sees the verdict live on the event socket. Three rules shape everything here:
 *
 *   - The actor of a decision is the token holder, never a body field.
 *   - Each action needs its own permission (approve / reject / escalate); an
 *     admin holds all three.
 *   - "Not yours" looks exactly like "does not exist": a mechanic asking for
 *     someone else's request gets 404, so an id cannot be probed.
 */

export type ModerationActionName = 'approved' | 'rejected' | 'escalated';
export type AccountRoleName = 'mechanic' | 'business';
export type ApprovalStatusName = 'pending' | 'approved' | 'rejected';

export const VERIFICATION_REQUEST_UPDATED = 'verification_request.updated';

/** Console roles receive every request event; the owner receives their own. */
const CONSOLE_AUDIENCE = ['admin', 'moderator'] as const;

const PERMISSION_BY_ACTION: Record<ModerationActionName, keyof AuthContext['permissions']> = {
  approved: 'canApprove',
  rejected: 'canReject',
  escalated: 'canEscalate',
};

export interface CredentialDocumentDto {
  id: string;
  ownerName: string;
  kind: 'mechanic_id' | 'document' | 'certification';
  label: string;
  fileName: string;
  uri: string;
  uploadedAt: string;
}

export interface AccountVerificationRequestDto {
  id: string;
  userNumber: string;
  name: string;
  email: string;
  role: AccountRoleName;
  submittedAt: string;
  documentNames: string[];
  documents: CredentialDocumentDto[];
  status: ApprovalStatusName;
  reason: string | null;
  reviewedAt: string | null;
  reviewerName: string | null;
  escalated: boolean;
}

export interface ModerationActivityDto {
  id: string;
  action: ModerationActionName;
  requestId: string;
  accountName: string;
  role: AccountRoleName;
  moderatorName: string;
  occurredAt: string;
  reason: string | null;
}

export interface DecisionMeta {
  /** Raw client IP, stored in full on the audit rows an admin reads. */
  ip: string;
  /** Keyed hash of the IP, for the security-event stream. */
  ipHash: Buffer;
  requestId: string;
}

interface RequestRow {
  id: string;
  user_id: string;
  user_number: string;
  name: string;
  email: string;
  role: AccountRoleName;
  submitted_at: Date;
  document_names: string[] | null;
  status: ApprovalStatusName;
  reason: string | null;
  reviewed_at: Date | null;
  escalated: boolean;
  has_reviewer: boolean;
  reviewer_first: string | null;
  reviewer_last: string | null;
  reviewer_email: string | null;
}

/**
 * Every read returns the full DTO shape. `documents` is empty until object
 * storage lands in Step 7; `documentNames` carries the labels submitted now.
 */
const SELECT_REQUEST = `
  SELECT ar.id, ar.user_id, ar.user_number, ar.name, ar.email,
         ar.role::text AS role, ar.submitted_at,
         to_json(ar.document_names) AS document_names,
         ar.status::text AS status, ar.reason, ar.reviewed_at, ar.escalated,
         (ar.reviewer_id IS NOT NULL) AS has_reviewer,
         rv.first_name AS reviewer_first, rv.last_name AS reviewer_last, rv.email AS reviewer_email
    FROM account_requests ar
    LEFT JOIN users rv ON rv.id = ar.reviewer_id`;

function toDto(row: RequestRow): AccountVerificationRequestDto {
  return {
    id: row.id,
    userNumber: row.user_number,
    name: row.name,
    email: row.email,
    role: row.role,
    submittedAt: row.submitted_at.toISOString(),
    documentNames: row.document_names ?? [],
    documents: [],
    status: row.status,
    reason: row.reason,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
    reviewerName: row.has_reviewer
      ? displayNameOf({
          first_name: row.reviewer_first ?? '',
          last_name: row.reviewer_last ?? '',
          email: row.reviewer_email ?? '',
        })
      : null,
    escalated: row.escalated,
  };
}

function fetchRequest(db: Queryable, id: string): Promise<RequestRow | null> {
  return db.queryOne<RequestRow>(`${SELECT_REQUEST} WHERE ar.id = $1`, [id]);
}

async function publishUpdate(events: EventBus, dto: AccountVerificationRequestDto, ownerId: string): Promise<void> {
  await events.publish({
    name: VERIFICATION_REQUEST_UPDATED,
    data: dto,
    audience: { userIds: [ownerId], roles: CONSOLE_AUDIENCE },
  });
}

export async function submitVerification(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  input: { name: string; email: string; role: AccountRoleName; documentNames?: string[] },
  meta: DecisionMeta,
): Promise<AccountVerificationRequestDto> {
  const documentNames = (input.documentNames ?? []).map((name) => name.trim()).filter((name) => name.length > 0);

  let row: RequestRow;
  try {
    const inserted = await db.queryOne<{ id: string }>(
      `INSERT INTO account_requests
         (user_id, user_number, role, name, email, document_names)
       VALUES ($1,
               'ONG-' || to_char(nextval('account_request_number_seq'), 'FM000000'),
               $2::requested_role, $3, $4, $5::text[])
       RETURNING id`,
      [auth.userId, input.role, input.name.trim(), input.email.trim().toLowerCase(), documentNames],
    );
    const fetched = inserted && (await fetchRequest(db, inserted.id));
    if (!fetched) throw new Error('verification request insert produced no row');
    row = fetched;
  } catch (err) {
    // The partial unique index (one pending per user) surfaces here.
    if (isUniqueViolation(err)) {
      throw conflict('You already have a verification request awaiting review.');
    }
    throw err;
  }

  const dto = toDto(row);
  await publishUpdate(events, dto, auth.userId);
  return dto;
}

export async function listVerificationRequests(
  db: Queryable,
  filters: { status?: ApprovalStatusName; escalatedOnly?: boolean; search?: string },
): Promise<AccountVerificationRequestDto[]> {
  const search = filters.search?.trim();
  const rows = await db.query<RequestRow>(
    `${SELECT_REQUEST}
      WHERE ($1::approval_status IS NULL OR ar.status = $1::approval_status)
        AND ($2::boolean IS NOT TRUE OR ar.escalated IS TRUE)
        AND ($3::text IS NULL OR
             ar.name ILIKE '%' || $3 || '%' OR
             ar.email ILIKE '%' || $3 || '%' OR
             ar.user_number ILIKE '%' || $3 || '%')
      ORDER BY ar.submitted_at DESC`,
    [filters.status ?? null, filters.escalatedOnly ?? false, search && search.length > 0 ? search : null],
  );
  return rows.map(toDto);
}

/**
 * A mechanic sees only their own request; a console role sees any. The two
 * "cannot read this" cases collapse to the same 404 so an id cannot be probed.
 */
export async function findVerificationRequest(
  db: Queryable,
  auth: AuthContext,
  id: string,
): Promise<AccountVerificationRequestDto> {
  const row = await fetchRequest(db, id);
  const isConsole = auth.role === 'admin' || auth.role === 'moderator';
  if (!row || (!isConsole && row.user_id !== auth.userId)) throw notFound('Verification request not found.');
  return toDto(row);
}

export async function decideVerification(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  id: string,
  input: { action: ModerationActionName; reason?: string | null },
  meta: DecisionMeta,
): Promise<AccountVerificationRequestDto> {
  const flag = PERMISSION_BY_ACTION[input.action];
  if (!auth.permissions[flag]) {
    await recordSecurityEvent(db, {
      event: SecurityEvent.AUTHZ_DENIED,
      severity: 'warning',
      actorId: auth.userId,
      actorRole: auth.role,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      metadata: { permission: flag, action: input.action, requestId: id },
    });
    throw forbidden('You do not have permission for that action.');
  }

  const reason = input.reason?.trim() || null;

  // The row, the activity feed and the audit trail move together; the event
  // and the security log are emitted after the commit.
  const updated = await db.withTransaction(async (tx) => {
    const row = await tx.queryOne<RequestRow>(`${SELECT_REQUEST} WHERE ar.id = $1 FOR UPDATE OF ar`, [id]);
    if (!row) throw notFound('Verification request not found.');
    if (row.status !== 'pending') throw conflict('This request has already been decided.');
    if (input.action === 'escalated' && row.escalated) throw conflict('This request is already escalated.');

    if (input.action === 'escalated') {
      // Escalation hands the request up to an admin: it stays pending, so it
      // still shows in the queue, but flagged.
      await tx.query(`UPDATE account_requests SET escalated = TRUE, reason = COALESCE($2, reason) WHERE id = $1`, [
        id,
        reason,
      ]);
    } else {
      await tx.query(
        `UPDATE account_requests
            SET status = $2::approval_status, reason = $3, reviewed_at = now(), reviewer_id = $4
          WHERE id = $1`,
        [id, input.action, reason, auth.userId],
      );
    }

    await tx.query(
      `INSERT INTO moderator_activity
         (action, request_id, account_name, account_role, moderator_id, moderator_name, reason, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet)`,
      [input.action, id, row.name, row.role, auth.userId, auth.displayName, reason, meta.ip],
    );

    await tx.query(
      `INSERT INTO admin_audit_log
         (actor_id, actor_name, actor_role, action, subject_id, subject_name, subject_role, reason, ip_address)
       VALUES ($1, $2, $3::user_role, $4, $5, $6, $7, $8, $9::inet)`,
      [auth.userId, auth.displayName, auth.role, input.action, row.user_id, row.name, row.role, reason, meta.ip],
    );

    const fresh = await tx.queryOne<RequestRow>(`${SELECT_REQUEST} WHERE ar.id = $1`, [id]);
    if (!fresh) throw new Error('verification request vanished mid-decision');
    return fresh;
  });

  await recordSecurityEvent(db, {
    event: SecurityEvent.MODERATION_DECISION,
    severity: 'notice',
    actorId: auth.userId,
    actorRole: auth.role,
    targetType: 'account_request',
    targetId: id,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
    metadata: { action: input.action },
  });

  const dto = toDto(updated);
  await publishUpdate(events, dto, updated.user_id);
  return dto;
}

interface ActivityRow {
  id: string;
  action: ModerationActionName;
  request_id: string | null;
  account_name: string;
  account_role: AccountRoleName;
  moderator_name: string;
  created_at: Date;
  reason: string | null;
}

export async function listModerationActivity(db: Queryable, limit: number): Promise<ModerationActivityDto[]> {
  const rows = await db.query<ActivityRow>(
    `SELECT id, action, request_id, account_name, account_role::text AS account_role,
            moderator_name, created_at, reason
       FROM moderator_activity
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    requestId: row.request_id ?? '',
    accountName: row.account_name,
    role: row.account_role,
    moderatorName: row.moderator_name,
    occurredAt: row.created_at.toISOString(),
    reason: row.reason,
  }));
}

// Re-exported so a route can throw the same shape the service uses.
export { AppError };
