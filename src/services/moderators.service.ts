import type { AuthContext } from '../auth/guard.js';
import { hashPassword } from '../auth/password.js';
import { revokeUserSessions } from '../auth/sessions.js';
import {
  displayNameOf,
  findUserByEmail,
  insertUser,
  normalizeEmail,
  permissionsFromRow,
  type Permissions,
} from '../auth/users.js';
import type { Database, Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import { recordSecurityEvent, SecurityEvent } from '../logging/audit.js';
import { conflict, isUniqueViolation, notFound } from '../utils/errors.js';

/**
 * The moderator directory and the audit log — admin only.
 *
 * An admin creates and removes moderators and sets what each one may do. Two
 * invariants hold:
 *
 *   - The application role cannot change a user's `role` column (see
 *     migrations/002), so "create a moderator" is an INSERT with role set at
 *     birth, and there is no path that promotes an existing account.
 *   - Removing a moderator deactivates the account AND revokes its sessions, so
 *     access ends on the next request, not whenever a token happens to expire.
 *
 * The audit log is a single stream: this module writes roster changes
 * (added / removed / promoted) and the verification service writes queue
 * decisions (approved / rejected / escalated), both into admin_audit_log, so
 * `listAuditLog` is one ordered read over the whole console.
 */

export const MODERATOR_UPDATED = 'moderator.updated';
const CONSOLE_AUDIENCE = ['admin', 'moderator'] as const;
const DISPLAY_ROLE = 'Moderator';

export type ModeratorStatusName = 'active' | 'inactive';
export type AuditActionName = 'added' | 'removed' | 'promoted' | 'approved' | 'rejected' | 'escalated';

export interface ModeratorAccountDto {
  id: string;
  name: string;
  email: string;
  role: string;
  status: ModeratorStatusName;
  addedAt: string;
  actionsHandled: number;
  permissions: Permissions;
  photoUrl: string | null;
}

export interface AuditEntryDto {
  id: string;
  moderatorName: string;
  action: AuditActionName;
  role: string;
  actorName: string;
  actorRole: string;
  ipAddress: string | null;
  occurredAt: string;
  reason: string | null;
}

export interface AdminActionMeta {
  ip: string;
  ipHash: Buffer;
  requestId: string;
}

interface ModeratorRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  status: string;
  created_at: Date;
  photo_url: string | null;
  can_approve: boolean | null;
  can_reject: boolean | null;
  can_escalate: boolean | null;
  can_change_background: boolean | null;
  actions_handled: number;
}

const SELECT_MODERATOR = `
  SELECT u.id, u.first_name, u.last_name, u.email, u.status::text AS status,
         u.created_at, u.photo_url,
         mp.can_approve, mp.can_reject, mp.can_escalate, mp.can_change_background,
         (SELECT count(*)::int FROM moderator_activity ma WHERE ma.moderator_id = u.id) AS actions_handled
    FROM users u
    LEFT JOIN moderator_permissions mp ON mp.user_id = u.id
   WHERE u.role = 'moderator'::user_role`;

function toDto(row: ModeratorRow): ModeratorAccountDto {
  return {
    id: row.id,
    name: displayNameOf(row),
    email: row.email,
    role: DISPLAY_ROLE,
    status: row.status === 'active' ? 'active' : 'inactive',
    addedAt: row.created_at.toISOString(),
    actionsHandled: row.actions_handled,
    permissions: permissionsFromRow(row),
    photoUrl: row.photo_url && row.photo_url.length > 0 ? row.photo_url : null,
  };
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

async function fetchModerator(db: Queryable, id: string): Promise<ModeratorRow | null> {
  return db.queryOne<ModeratorRow>(`${SELECT_MODERATOR} AND u.id = $1`, [id]);
}

async function writeAudit(
  db: Queryable,
  input: {
    actor: AuthContext;
    action: AuditActionName;
    subjectId: string;
    subjectName: string;
    subjectRole: string;
    reason: string | null;
    ip: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO admin_audit_log
       (actor_id, actor_name, actor_role, action, subject_id, subject_name, subject_role, reason, ip_address)
     VALUES ($1, $2, $3::user_role, $4, $5, $6, $7, $8, $9::inet)`,
    [
      input.actor.userId,
      input.actor.displayName,
      input.actor.role,
      input.action,
      input.subjectId,
      input.subjectName,
      input.subjectRole,
      input.reason,
      input.ip,
    ],
  );
}

export async function listModerators(db: Queryable): Promise<ModeratorAccountDto[]> {
  const rows = await db.query<ModeratorRow>(`${SELECT_MODERATOR} ORDER BY u.created_at DESC`);
  return rows.map(toDto);
}

export async function createModerator(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  input: { name: string; email: string; temporaryPassword: string; permissions?: Permissions },
  meta: AdminActionMeta,
): Promise<ModeratorAccountDto> {
  const email = normalizeEmail(input.email);
  if (await findUserByEmail(db, email)) throw conflict('An account with that email already exists.');

  const passwordHash = await hashPassword(input.temporaryPassword);
  const { first, last } = splitName(input.name);
  const permissions: Permissions = input.permissions ?? {
    canApprove: true,
    canReject: true,
    canEscalate: false,
    canChangeBackground: false,
  };

  let id: string;
  try {
    id = await db.withTransaction(async (tx) => {
      const user = await insertUser(tx, {
        email,
        passwordHash,
        role: 'moderator',
        firstName: first,
        lastName: last,
      });
      await tx.query(
        `INSERT INTO moderator_permissions
           (user_id, can_approve, can_reject, can_escalate, can_change_background, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, permissions.canApprove, permissions.canReject, permissions.canEscalate, permissions.canChangeBackground, auth.userId],
      );
      await writeAudit(tx, {
        actor: auth,
        action: 'added',
        subjectId: user.id,
        subjectName: displayNameOf(user),
        subjectRole: 'moderator',
        reason: null,
        ip: meta.ip,
      });
      return user.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('An account with that email already exists.');
    throw err;
  }

  const row = await fetchModerator(db, id);
  if (!row) throw new Error('created moderator vanished');
  await recordSecurityEvent(db, {
    event: SecurityEvent.PRIVILEGE_CHANGED,
    severity: 'notice',
    actorId: auth.userId,
    actorRole: auth.role,
    targetType: 'moderator',
    targetId: id,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
    metadata: { action: 'added' },
  });
  const dto = toDto(row);
  await events.publish({ name: MODERATOR_UPDATED, data: dto, audience: { roles: CONSOLE_AUDIENCE } });
  return dto;
}

export async function removeModerator(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  id: string,
  reason: string | null,
  meta: AdminActionMeta,
): Promise<ModeratorAccountDto> {
  const target = await fetchModerator(db, id);
  if (!target) throw notFound('Moderator not found.');

  await db.withTransaction(async (tx) => {
    await tx.query(`UPDATE users SET status = 'suspended'::user_status WHERE id = $1 AND role = 'moderator'::user_role`, [id]);
    await revokeUserSessions(tx, id, 'revoked_by_admin');
    await writeAudit(tx, {
      actor: auth,
      action: 'removed',
      subjectId: id,
      subjectName: displayNameOf(target),
      subjectRole: 'moderator',
      reason: reason?.trim() || null,
      ip: meta.ip,
    });
  });

  await recordSecurityEvent(db, {
    event: SecurityEvent.PRIVILEGE_CHANGED,
    severity: 'warning',
    actorId: auth.userId,
    actorRole: auth.role,
    targetType: 'moderator',
    targetId: id,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
    metadata: { action: 'removed' },
  });

  const row = await fetchModerator(db, id);
  const dto = toDto(row ?? target);
  await events.publish({ name: MODERATOR_UPDATED, data: dto, audience: { roles: CONSOLE_AUDIENCE } });
  return dto;
}

export async function updateModeratorPermissions(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  id: string,
  permissions: Permissions,
  meta: AdminActionMeta,
): Promise<ModeratorAccountDto> {
  const target = await fetchModerator(db, id);
  if (!target) throw notFound('Moderator not found.');

  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO moderator_permissions
         (user_id, can_approve, can_reject, can_escalate, can_change_background, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id) DO UPDATE
         SET can_approve = EXCLUDED.can_approve,
             can_reject = EXCLUDED.can_reject,
             can_escalate = EXCLUDED.can_escalate,
             can_change_background = EXCLUDED.can_change_background,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [id, permissions.canApprove, permissions.canReject, permissions.canEscalate, permissions.canChangeBackground, auth.userId],
    );
    await writeAudit(tx, {
      actor: auth,
      action: 'promoted',
      subjectId: id,
      subjectName: displayNameOf(target),
      subjectRole: 'moderator',
      reason: null,
      ip: meta.ip,
    });
  });

  await recordSecurityEvent(db, {
    event: SecurityEvent.PRIVILEGE_CHANGED,
    severity: 'notice',
    actorId: auth.userId,
    actorRole: auth.role,
    targetType: 'moderator',
    targetId: id,
    ipHash: meta.ipHash,
    requestId: meta.requestId,
    metadata: { action: 'permissions' },
  });

  const row = await fetchModerator(db, id);
  if (!row) throw new Error('moderator vanished after permission update');
  const dto = toDto(row);
  // The moderator's own console re-reads rights from this signal; rights are
  // enforced from the database on every request regardless.
  await events.publish({ name: MODERATOR_UPDATED, data: dto, audience: { roles: CONSOLE_AUDIENCE, userIds: [id] } });
  return dto;
}

export async function updateModeratorProfile(
  db: Database,
  events: EventBus,
  auth: AuthContext,
  id: string,
  input: { name?: string; photoUrl?: string | null },
  meta: AdminActionMeta,
): Promise<ModeratorAccountDto> {
  const target = await fetchModerator(db, id);
  if (!target) throw notFound('Moderator not found.');

  const named = input.name !== undefined;
  const { first, last } = named ? splitName(input.name ?? '') : { first: '', last: '' };
  const photoProvided = input.photoUrl !== undefined;
  // Null or an empty value both mean "clear it", stored as NULL, not ''.
  const photoValue = input.photoUrl && input.photoUrl.length > 0 ? input.photoUrl : null;

  await db.query(
    `UPDATE users
        SET first_name = CASE WHEN $2::boolean THEN $3 ELSE first_name END,
            last_name  = CASE WHEN $2::boolean THEN $4 ELSE last_name END,
            photo_url  = CASE WHEN $5::boolean THEN $6 ELSE photo_url END
      WHERE id = $1 AND role = 'moderator'::user_role`,
    [id, named, first, last, photoProvided, photoValue],
  );

  const row = await fetchModerator(db, id);
  if (!row) throw new Error('moderator vanished after profile update');
  const dto = toDto(row);
  await events.publish({ name: MODERATOR_UPDATED, data: dto, audience: { roles: CONSOLE_AUDIENCE } });
  return dto;
}

interface AuditRow {
  id: string;
  subject_name: string;
  action: AuditActionName;
  subject_role: string;
  actor_name: string;
  actor_role: string | null;
  ip_address: string | null;
  created_at: Date;
  reason: string | null;
}

export async function listAuditLog(db: Queryable, limit = 200): Promise<AuditEntryDto[]> {
  const rows = await db.query<AuditRow>(
    `SELECT id, subject_name, action, subject_role, actor_name,
            actor_role::text AS actor_role, ip_address::text AS ip_address, created_at, reason
       FROM admin_audit_log
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    moderatorName: row.subject_name,
    action: row.action,
    role: row.subject_role,
    actorName: row.actor_name,
    actorRole: row.actor_role ?? 'admin',
    ipAddress: row.ip_address,
    occurredAt: row.created_at.toISOString(),
    reason: row.reason,
  }));
}
