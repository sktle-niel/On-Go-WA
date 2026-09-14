import type { AuthContext } from '../auth/guard.js';
import { displayNameOf } from '../auth/users.js';
import type { Database, Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import { recordSecurityEvent, SecurityEvent } from '../logging/audit.js';
import type { Storage } from '../storage/storage.js';
import { conflict, forbidden, isUniqueViolation, notFound } from '../utils/errors.js';

/**
 * Account verification — the mobile → console → mobile round trip.
 *
 * A mechanic files a request and uploads their documents; a moderator or admin
 * decides it; the mobile app sees the verdict live on the event socket. Three
 * rules shape everything here:
 *
 *   - The actor of a decision is the token holder, never a body field.
 *   - Each action needs its own permission (approve / reject / escalate); an
 *     admin holds all three.
 *   - "Not yours" looks exactly like "does not exist": a mechanic asking for
 *     someone else's request gets 404, so an id cannot be probed.
 *
 * Every document's `uri` is a short-lived signed URL, minted per read, so a
 * link copied out of the console stops working before long.
 */

export type ModerationActionName = 'approved' | 'rejected' | 'escalated';
export type AccountRoleName = 'mechanic' | 'business';
export type ApprovalStatusName = 'pending' | 'approved' | 'rejected';
export type CredentialKindName = 'mechanic_id' | 'document' | 'certification';

export const VERIFICATION_REQUEST_UPDATED = 'verification_request.updated';

const CONSOLE_AUDIENCE = ['admin', 'moderator'] as const;

const PERMISSION_BY_ACTION: Record<ModerationActionName, keyof AuthContext['permissions']> = {
  approved: 'canApprove',
  rejected: 'canReject',
  escalated: 'canEscalate',
};

export interface CredentialDocumentDto {
  id: string;
  ownerName: string;
  kind: CredentialKindName;
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
  ip: string;
  ipHash: Buffer;
  requestId: string;
}

/** Storage plus the signed-URL lifetime, threaded through so document URIs can
 *  be minted wherever a request DTO is built. */
export interface DocumentContext {
  storage: Storage;
  urlTtlSeconds: number;
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

interface DocumentRow {
  id: string;
  s3_key: string;
  kind: CredentialKindName;
  label: string;
  file_name: string;
  uploaded_at: Date;
}

const SELECT_REQUEST = `
  SELECT ar.id, ar.user_id, ar.user_number, ar.name, ar.email,
         ar.role::text AS role, ar.submitted_at,
         to_json(ar.document_names) AS document_names,
         ar.status::text AS status, ar.reason, ar.reviewed_at, ar.escalated,
         (ar.reviewer_id IS NOT NULL) AS has_reviewer,
         rv.first_name AS reviewer_first, rv.last_name AS reviewer_last, rv.email AS reviewer_email
    FROM account_requests ar
    LEFT JOIN users rv ON rv.id = ar.reviewer_id`;

async function loadDocuments(db: Queryable, docs: DocumentContext, row: RequestRow): Promise<CredentialDocumentDto[]> {
  const rows = await db.query<DocumentRow>(
    `SELECT id, s3_key, kind::text AS kind, label, file_name, uploaded_at
       FROM account_request_documents
      WHERE request_id = $1
      ORDER BY uploaded_at`,
    [row.id],
  );
  return rows.map((doc) => ({
    id: doc.id,
    ownerName: row.name,
    kind: doc.kind,
    label: doc.label.length > 0 ? doc.label : doc.file_name,
    fileName: doc.file_name,
    uri: docs.storage.signedUrl(doc.s3_key, docs.urlTtlSeconds),
    uploadedAt: doc.uploaded_at.toISOString(),
  }));
}

async function toDto(db: Queryable, docs: DocumentContext, row: RequestRow): Promise<AccountVerificationRequestDto> {
  return {
    id: row.id,
    userNumber: row.user_number,
    name: row.name,
    email: row.email,
    role: row.role,
    submittedAt: row.submitted_at.toISOString(),
    documentNames: row.document_names ?? [],
    documents: await loadDocuments(db, docs, row),
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
  docs: DocumentContext,
  auth: AuthContext,
  input: { name: string; email: string; role: AccountRoleName; documentNames?: string[] },
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
    if (isUniqueViolation(err)) {
      throw conflict('You already have a verification request awaiting review.');
    }
    throw err;
  }

  const dto = await toDto(db, docs, row);
  await publishUpdate(events, dto, auth.userId);
  return dto;
}

/**
 * Cheap ownership/state check before the request body is read, so a caller who
 * does not own the request (or whose request is already decided) is turned away
 * without the server buffering their upload. The authoritative check runs again
 * inside the transaction in addVerificationDocument.
 */
export async function precheckDocumentUpload(db: Queryable, auth: AuthContext, requestId: string): Promise<void> {
  const row = await db.queryOne<{ user_id: string; status: ApprovalStatusName }>(
    `SELECT user_id, status::text AS status FROM account_requests WHERE id = $1`,
    [requestId],
  );
  if (!row || row.user_id !== auth.userId) throw notFound('Verification request not found.');
  if (row.status !== 'pending') throw conflict('This request has already been decided.');
}

export async function addVerificationDocument(
  db: Database,
  events: EventBus,
  docs: DocumentContext,
  auth: AuthContext,
  requestId: string,
  upload: { body: Buffer; contentType: string; ext: string; fileName: string; kind: CredentialKindName; label: string },
  maxDocuments: number,
): Promise<AccountVerificationRequestDto> {
  // Store first, then commit the row; if the commit is refused (not owner, not
  // pending, or the per-request cap), delete the just-stored file so nothing is
  // orphaned. The request row is locked so the cap check and insert are atomic
  // against a second concurrent upload.
  const stored = await docs.storage.put({ kind: 'document', ext: upload.ext, body: upload.body });
  try {
    await db.withTransaction(async (tx) => {
      const row = await tx.queryOne<{ user_id: string; status: ApprovalStatusName }>(
        `SELECT user_id, status::text AS status FROM account_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      if (!row || row.user_id !== auth.userId) throw notFound('Verification request not found.');
      if (row.status !== 'pending') throw conflict('This request has already been decided.');

      const count = await tx.queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM account_request_documents WHERE request_id = $1`,
        [requestId],
      );
      if ((count?.n ?? 0) >= maxDocuments) {
        throw conflict(`A verification request may hold at most ${maxDocuments} documents.`);
      }

      await tx.query(
        `INSERT INTO account_request_documents
           (request_id, s3_key, content_type, byte_size, sha256, kind, label, file_name)
         VALUES ($1, $2, $3, $4, $5, $6::credential_kind, $7, $8)`,
        [requestId, stored.key, upload.contentType, stored.bytes, stored.sha256, upload.kind, upload.label, upload.fileName],
      );
    });
  } catch (err) {
    await docs.storage.delete(stored.key).catch(() => undefined);
    throw err;
  }

  const fresh = await fetchRequest(db, requestId);
  if (!fresh) throw new Error('request vanished after document upload');
  const dto = await toDto(db, docs, fresh);
  await publishUpdate(events, dto, fresh.user_id);
  return dto;
}

/** Neutralises LIKE wildcards (%, _, \) in a caller's search term, so a search
 *  is a literal substring match and cannot be turned into "match everything". */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function listVerificationRequests(
  db: Queryable,
  docs: DocumentContext,
  filters: { status?: ApprovalStatusName; escalatedOnly?: boolean; search?: string },
): Promise<AccountVerificationRequestDto[]> {
  const search = filters.search?.trim();
  const like = search && search.length > 0 ? escapeLike(search) : null;
  const rows = await db.query<RequestRow>(
    `${SELECT_REQUEST}
      WHERE ($1::approval_status IS NULL OR ar.status = $1::approval_status)
        AND ($2::boolean IS NOT TRUE OR ar.escalated IS TRUE)
        AND ($3::text IS NULL OR
             ar.name ILIKE '%' || $3 || '%' ESCAPE '\\' OR
             ar.email ILIKE '%' || $3 || '%' ESCAPE '\\' OR
             ar.user_number ILIKE '%' || $3 || '%' ESCAPE '\\')
      ORDER BY ar.submitted_at DESC`,
    [filters.status ?? null, filters.escalatedOnly ?? false, like],
  );
  return Promise.all(rows.map((row) => toDto(db, docs, row)));
}

export async function findVerificationRequest(
  db: Queryable,
  docs: DocumentContext,
  auth: AuthContext,
  id: string,
): Promise<AccountVerificationRequestDto> {
  const row = await fetchRequest(db, id);
  const isConsole = auth.role === 'admin' || auth.role === 'moderator';
  if (!row || (!isConsole && row.user_id !== auth.userId)) throw notFound('Verification request not found.');
  return toDto(db, docs, row);
}

export async function decideVerification(
  db: Database,
  events: EventBus,
  docs: DocumentContext,
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

  const updated = await db.withTransaction(async (tx) => {
    const row = await tx.queryOne<RequestRow>(`${SELECT_REQUEST} WHERE ar.id = $1 FOR UPDATE OF ar`, [id]);
    if (!row) throw notFound('Verification request not found.');
    if (row.status !== 'pending') throw conflict('This request has already been decided.');
    if (input.action === 'escalated' && row.escalated) throw conflict('This request is already escalated.');

    if (input.action === 'escalated') {
      await tx.query(`UPDATE account_requests SET escalated = TRUE, reason = COALESCE($2, reason) WHERE id = $1`, [id, reason]);
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

  const dto = await toDto(db, docs, updated);
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
