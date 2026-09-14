import type { Queryable } from '../db/database.js';
import type { TokenRole } from './tokens.js';

/**
 * The users table, and the moderator permissions that hang off it.
 *
 * Plain functions over a Queryable rather than a repository class, so the same
 * code runs inside a transaction (pass the tx) or outside one (pass the db).
 */

export type UserStatus = 'active' | 'suspended' | 'deleted';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: TokenRole;
  status: UserStatus;
  first_name: string;
  last_name: string;
  phone: string;
  address: string;
  photo_url: string | null;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  tokens_valid_from: Date;
  password_changed_at: Date;
  created_at: Date;
}

const USER_COLUMNS =
  'id, email, password_hash, role::text AS role, status::text AS status, first_name, last_name, ' +
  'phone, address, photo_url, failed_login_count, locked_until, last_login_at, tokens_valid_from, ' +
  'password_changed_at, created_at';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function findUserByEmail(db: Queryable, email: string): Promise<UserRow | null> {
  return db.queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
    [normalizeEmail(email)],
  );
}

export function findUserById(db: Queryable, id: string): Promise<UserRow | null> {
  return db.queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
}

export async function insertUser(
  db: Queryable,
  input: {
    email: string;
    passwordHash: string;
    role: TokenRole;
    firstName: string;
    lastName: string;
    phone?: string;
  },
): Promise<UserRow> {
  const row = await db.queryOne<UserRow>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
     VALUES ($1, $2, $3::user_role, $4, $5, $6)
     RETURNING ${USER_COLUMNS}`,
    [
      normalizeEmail(input.email),
      input.passwordHash,
      input.role,
      input.firstName.trim(),
      input.lastName.trim(),
      input.phone?.trim() ?? '',
    ],
  );
  if (!row) throw new Error('INSERT ... RETURNING produced no row');
  return row;
}

export function displayNameOf(user: Pick<UserRow, 'first_name' | 'last_name' | 'email'>): string {
  const name = `${user.first_name} ${user.last_name}`.trim();
  return name.length > 0 ? name : user.email;
}

export function isLocked(user: Pick<UserRow, 'locked_until'>, now = new Date()): boolean {
  return user.locked_until !== null && user.locked_until.getTime() > now.getTime();
}

/**
 * Counts a failed attempt and locks the account once the limit is reached.
 * Done in one statement so two concurrent failures cannot both read "7" and
 * neither lock.
 */
export async function recordFailedLogin(
  db: Queryable,
  userId: string,
  maxAttempts: number,
  lockoutSeconds: number,
): Promise<{ locked: boolean }> {
  const row = await db.queryOne<{ locked_until: Date | null }>(
    `UPDATE users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE
              WHEN failed_login_count + 1 >= $2::int
                THEN now() + ($3::int * interval '1 second')
              ELSE locked_until
            END
      WHERE id = $1
      RETURNING locked_until`,
    [userId, maxAttempts, lockoutSeconds],
  );
  return { locked: row !== null && isLocked(row) };
}

export function recordSuccessfulLogin(db: Queryable, userId: string): Promise<unknown> {
  return db.query(
    `UPDATE users
        SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
      WHERE id = $1`,
    [userId],
  );
}

/**
 * Also moves `tokens_valid_from`, which retires every access token issued
 * before this moment — the holder of a stolen token is out on the next request.
 *
 * The cut-off is set one second AHEAD of now, not to now, because a JWT `iat`
 * has one-second resolution and every token issued in the current second may
 * already carry `iat = ceil(previous tokens_valid_from)`, which rounds up into
 * this same second (see tokensValidFromSeconds and issueAccessToken). Setting
 * the cut-off to `now()` would leave those tokens with `iat == ceil(cut-off)`,
 * and the guard's strict `>` would keep them alive for the rest of the second —
 * so a password changed within a second of sign-in would not retire the old
 * access token. Advancing a full second guarantees `ceil(cut-off)` exceeds any
 * `iat` issued up to now; the replacement token minted right after this uses
 * `ceil(tokens_valid_from)` as its own `iat`, so it stays valid.
 */
export async function updatePassword(
  db: Queryable,
  userId: string,
  passwordHash: string,
): Promise<{ tokensValidFrom: Date }> {
  const row = await db.queryOne<{ tokens_valid_from: Date }>(
    `UPDATE users
        SET password_hash = $2, password_changed_at = now(),
            tokens_valid_from = now() + interval '1 second'
      WHERE id = $1
      RETURNING tokens_valid_from`,
    [userId, passwordHash],
  );
  return { tokensValidFrom: row?.tokens_valid_from ?? new Date() };
}

export interface Permissions {
  canApprove: boolean;
  canReject: boolean;
  canEscalate: boolean;
  canChangeBackground: boolean;
}

export const ALL_PERMISSIONS: Permissions = {
  canApprove: true,
  canReject: true,
  canEscalate: true,
  canChangeBackground: true,
};

export const NO_PERMISSIONS: Permissions = {
  canApprove: false,
  canReject: false,
  canEscalate: false,
  canChangeBackground: false,
};

interface PermissionRow {
  can_approve: boolean;
  can_reject: boolean;
  can_escalate: boolean;
  can_change_background: boolean;
}

export function permissionsFromRow(
  row: Partial<Record<keyof PermissionRow, boolean | null>> | null | undefined,
): Permissions {
  if (!row) return NO_PERMISSIONS;
  return {
    canApprove: row.can_approve === true,
    canReject: row.can_reject === true,
    canEscalate: row.can_escalate === true,
    canChangeBackground: row.can_change_background === true,
  };
}

/** Admins hold every permission by definition; clients and mechanics none. */
export async function loadPermissions(
  db: Queryable,
  userId: string,
  role: TokenRole,
): Promise<Permissions> {
  if (role === 'admin') return ALL_PERMISSIONS;
  if (role !== 'moderator') return NO_PERMISSIONS;
  const row = await db.queryOne<PermissionRow>(
    `SELECT can_approve, can_reject, can_escalate, can_change_background
       FROM moderator_permissions WHERE user_id = $1`,
    [userId],
  );
  return permissionsFromRow(row);
}
