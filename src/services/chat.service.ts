import type { AuthContext } from '../auth/guard.js';
import { displayNameOf } from '../auth/users.js';
import type { Database, Queryable } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import type { Storage } from '../storage/storage.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';

/**
 * Job chat (Step 10 slice 8): the conversation between a client and the
 * mechanic matched to their job.
 *
 *   - Only the two parties take part. Anyone else is told the job does not
 *     exist, the same answer the jobs routes give.
 *   - A conversation belongs to one match. Each message records the job's
 *     mechanic when it was sent, and a thread shows only the current match's
 *     messages, so a mechanic who takes a job someone else let go starts with
 *     an empty chat and never reads the earlier one.
 *   - Messages can be sent while the job is matched. After payment, a cancel or
 *     a return to the pool nothing more can be added; the history of a paid job
 *     stays readable to both.
 *   - Unread counts are measured from a read marker per participant, compared
 *     in SQL so no precision is lost. Sending a message counts as having read
 *     the thread up to it, as in the app.
 */

export const CHAT_MESSAGE_CREATED = 'chat_message.created';

const MAX_BODY = 2000;

export interface ChatFiles {
  storage: Storage;
  urlTtlSeconds: number;
}

export interface ChatMessageDto {
  id: string;
  requestId: string;
  senderId: string;
  senderRole: 'client' | 'mechanic';
  senderName: string;
  body: string | null;
  imageUrl: string | null;
  replyToId: string | null;
  sentAt: string;
}

export interface ChatThreadDto {
  requestId: string;
  open: boolean;
  otherPartyName: string | null;
  unreadCount: number;
  lastReadAt: string | null;
  hasMore: boolean;
  messages: ChatMessageDto[];
}

export interface ChatReadStateDto {
  requestId: string;
  lastReadAt: string | null;
  unreadCount: number;
}

export interface ChatUnreadDto {
  requestId: string;
  unreadCount: number;
  lastMessageAt: string;
}

interface Conversation {
  requestId: string;
  clientId: string;
  /** The current match's mechanic; null while the job is in the pool. */
  mechanicId: string | null;
  role: 'client' | 'mechanic';
  open: boolean;
}

interface MessageRow {
  id: string;
  request_id: string;
  sender_id: string;
  sender_role: 'client' | 'mechanic';
  body: string | null;
  image_key: string | null;
  reply_to_id: string | null;
  sent_at: Date;
  first_name: string;
  last_name: string;
  email: string;
}

const SELECT_MESSAGE = `
  SELECT cm.id, cm.request_id, cm.sender_id, cm.sender_role::text AS sender_role, cm.body, cm.image_key,
         cm.reply_to_id, cm.sent_at, u.first_name, u.last_name, u.email
    FROM chat_messages cm
    JOIN users u ON u.id = cm.sender_id`;

function toDto(row: MessageRow, files: ChatFiles): ChatMessageDto {
  return {
    id: row.id,
    requestId: row.request_id,
    senderId: row.sender_id,
    senderRole: row.sender_role,
    senderName: displayNameOf(row),
    body: row.body,
    imageUrl: row.image_key ? files.storage.signedUrl(row.image_key, files.urlTtlSeconds) : null,
    replyToId: row.reply_to_id,
    sentAt: row.sent_at.toISOString(),
  };
}

/** The caller's place in a job's chat, or 404 when they have none. */
async function conversationFor(db: Queryable, auth: AuthContext, requestId: string, lock = false): Promise<Conversation> {
  const row = await db.queryOne<{ client_id: string; mechanic_id: string | null; status: string }>(
    lock
      ? `SELECT client_id, mechanic_id, status::text AS status FROM service_requests WHERE id = $1::uuid FOR SHARE`
      : `SELECT client_id, mechanic_id, status::text AS status FROM service_requests WHERE id = $1::uuid`,
    [requestId],
  );
  if (!row) throw notFound('Request not found.');

  let role: 'client' | 'mechanic';
  if (auth.userId === row.client_id) role = 'client';
  else if (row.mechanic_id !== null && auth.userId === row.mechanic_id) role = 'mechanic';
  else throw notFound('Request not found.');

  return {
    requestId,
    clientId: row.client_id,
    mechanicId: row.mechanic_id,
    role,
    open: row.status === 'matched' && row.mechanic_id !== null,
  };
}

/** Whether `messageId` is a message of this conversation. */
async function inConversation(db: Queryable, convo: Conversation, messageId: string): Promise<boolean> {
  const row = await db.queryOne<{ one: number }>(
    `SELECT 1 AS one FROM chat_messages WHERE id = $1::uuid AND request_id = $2::uuid AND mechanic_id = $3::uuid`,
    [messageId, convo.requestId, convo.mechanicId],
  );
  return row !== null;
}

async function readState(db: Queryable, convo: Conversation, userId: string): Promise<{ unreadCount: number; lastReadAt: string | null }> {
  const row = await db.queryOne<{ last_read_at: Date | null; unread: number }>(
    `SELECT r.last_read_at,
            (SELECT count(*)::int
               FROM chat_messages cm
              WHERE cm.request_id = $1::uuid AND cm.mechanic_id = $2::uuid AND cm.sender_id <> $3::uuid
                AND cm.sent_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)) AS unread
       FROM (SELECT (SELECT last_read_at FROM chat_reads WHERE request_id = $1::uuid AND user_id = $3::uuid) AS last_read_at) r`,
    [convo.requestId, convo.mechanicId, userId],
  );
  return {
    unreadCount: row?.unread ?? 0,
    lastReadAt: row?.last_read_at ? row.last_read_at.toISOString() : null,
  };
}

/** Moves the caller's read marker up to a message, never back. */
async function readUpTo(db: Queryable, requestId: string, userId: string, messageId: string): Promise<void> {
  await db.query(
    `INSERT INTO chat_reads (request_id, user_id, last_read_at)
     SELECT $1::uuid, $2::uuid, cm.sent_at FROM chat_messages cm WHERE cm.id = $3::uuid
     ON CONFLICT (request_id, user_id)
       DO UPDATE SET last_read_at = GREATEST(chat_reads.last_read_at, EXCLUDED.last_read_at)`,
    [requestId, userId, messageId],
  );
}

async function otherPartyName(db: Queryable, convo: Conversation): Promise<string | null> {
  const otherId = convo.role === 'client' ? convo.mechanicId : convo.clientId;
  if (otherId === null) return null;
  const user = await db.queryOne<{ first_name: string; last_name: string; email: string }>(
    `SELECT first_name, last_name, email FROM users WHERE id = $1::uuid`,
    [otherId],
  );
  return user ? displayNameOf(user) : null;
}

/** A page of the caller's conversation, newest page first, messages oldest first. */
export async function getChatThread(
  db: Queryable,
  files: ChatFiles,
  auth: AuthContext,
  requestId: string,
  query: { before?: string; limit?: number },
): Promise<ChatThreadDto> {
  const convo = await conversationFor(db, auth, requestId);
  const limit = query.limit ?? 50;

  let rows: MessageRow[] = [];
  if (query.before !== undefined && (convo.mechanicId === null || !(await inConversation(db, convo, query.before)))) {
    throw badRequest('`before` is not a message in this chat.');
  }
  if (convo.mechanicId !== null) {
    rows = await db.query<MessageRow>(
      `${SELECT_MESSAGE}
        WHERE cm.request_id = $1::uuid AND cm.mechanic_id = $2::uuid
          AND ($3::uuid IS NULL
               OR (cm.sent_at, cm.id) < (SELECT c.sent_at, c.id FROM chat_messages c WHERE c.id = $3::uuid))
        ORDER BY cm.sent_at DESC, cm.id DESC
        LIMIT $4::int`,
      [requestId, convo.mechanicId, query.before ?? null, limit + 1],
    );
  }

  const read = await readState(db, convo, auth.userId);
  return {
    requestId,
    open: convo.open,
    otherPartyName: await otherPartyName(db, convo),
    unreadCount: read.unreadCount,
    lastReadAt: read.lastReadAt,
    hasMore: rows.length > limit,
    messages: rows
      .slice(0, limit)
      .reverse()
      .map((row) => toDto(row, files)),
  };
}

/**
 * Refuses a send before an upload is read: the caller must be a party and the
 * chat must be open. `sendChatMessage` checks again under a lock.
 */
export async function precheckChatSend(db: Queryable, auth: AuthContext, requestId: string): Promise<void> {
  const convo = await conversationFor(db, auth, requestId);
  if (convo.mechanicId === null) throw conflict('There is no mechanic on this job to message yet.');
  if (!convo.open) throw conflict('This chat is closed: the job is no longer in progress.');
}

export async function sendChatMessage(
  db: Database,
  events: EventBus,
  files: ChatFiles,
  auth: AuthContext,
  requestId: string,
  input: { body?: string | null; replyToId?: string | null; imageKey?: string | null },
): Promise<ChatMessageDto> {
  const trimmed = input.body == null ? '' : input.body.trim();
  if (trimmed.length > MAX_BODY) throw badRequest(`A message can be at most ${MAX_BODY} characters.`);
  if (trimmed.length === 0 && !input.imageKey) throw badRequest('A message needs text or a photo.');

  const sent = await db.withTransaction(async (tx) => {
    // FOR SHARE: the match cannot change (reopen, cancel, pay) while this lands.
    const convo = await conversationFor(tx, auth, requestId, true);
    if (convo.mechanicId === null) throw conflict('There is no mechanic on this job to message yet.');
    if (!convo.open) throw conflict('This chat is closed: the job is no longer in progress.');
    if (input.replyToId && !(await inConversation(tx, convo, input.replyToId))) {
      throw badRequest('replyToId is not a message in this chat.');
    }

    const inserted = await tx.queryOne<{ id: string }>(
      `INSERT INTO chat_messages (request_id, sender_id, sender_role, mechanic_id, body, image_key, reply_to_id)
       VALUES ($1::uuid, $2::uuid, $3::chat_sender, $4::uuid, $5, $6, $7::uuid)
       RETURNING id`,
      [requestId, auth.userId, convo.role, convo.mechanicId, trimmed.length > 0 ? trimmed : null, input.imageKey ?? null, input.replyToId ?? null],
    );
    if (!inserted) throw new Error('chat message was not written');
    // Sending counts as having read the thread up to this message.
    await readUpTo(tx, requestId, auth.userId, inserted.id);
    return { id: inserted.id, parties: [convo.clientId, convo.mechanicId] };
  });

  const row = await db.queryOne<MessageRow>(`${SELECT_MESSAGE} WHERE cm.id = $1::uuid`, [sent.id]);
  if (!row) throw new Error('chat message vanished after insert');
  const dto = toDto(row, files);
  await events.publish({ name: CHAT_MESSAGE_CREATED, data: dto, audience: { userIds: sent.parties } });
  return dto;
}

/** Marks the caller's conversation read up to a message, or up to the newest one. */
export async function markChatRead(
  db: Queryable,
  auth: AuthContext,
  requestId: string,
  input: { upToMessageId?: string },
): Promise<ChatReadStateDto> {
  const convo = await conversationFor(db, auth, requestId);

  if (input.upToMessageId !== undefined) {
    if (convo.mechanicId === null || !(await inConversation(db, convo, input.upToMessageId))) {
      throw badRequest('upToMessageId is not a message in this chat.');
    }
    await readUpTo(db, requestId, auth.userId, input.upToMessageId);
  } else if (convo.mechanicId !== null) {
    const newest = await db.queryOne<{ id: string }>(
      `SELECT id FROM chat_messages
        WHERE request_id = $1::uuid AND mechanic_id = $2::uuid
        ORDER BY sent_at DESC, id DESC
        LIMIT 1`,
      [requestId, convo.mechanicId],
    );
    if (newest) await readUpTo(db, requestId, auth.userId, newest.id);
  }

  const read = await readState(db, convo, auth.userId);
  return { requestId, lastReadAt: read.lastReadAt, unreadCount: read.unreadCount };
}

/** The caller's jobs with unread messages in their current conversation, newest first. */
export async function listChatUnread(db: Queryable, auth: AuthContext): Promise<ChatUnreadDto[]> {
  const rows = await db.query<{ request_id: string; unread: number; last_at: Date }>(
    `SELECT sr.id AS request_id, count(cm.id)::int AS unread, max(cm.sent_at) AS last_at
       FROM service_requests sr
       JOIN chat_messages cm
         ON cm.request_id = sr.id AND cm.mechanic_id = sr.mechanic_id AND cm.sender_id <> $1::uuid
       LEFT JOIN chat_reads r ON r.request_id = sr.id AND r.user_id = $1::uuid
      WHERE (sr.client_id = $1::uuid OR sr.mechanic_id = $1::uuid)
        AND cm.sent_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
      GROUP BY sr.id
      ORDER BY max(cm.sent_at) DESC
      LIMIT 100`,
    [auth.userId],
  );
  return rows.map((row) => ({ requestId: row.request_id, unreadCount: row.unread, lastMessageAt: row.last_at.toISOString() }));
}
