import { Type } from '@fastify/type-provider-typebox';
import { DateTime, Nullable, StringEnum, Uuid } from './common.js';

/**
 * Job chat (Step 10 slice 8). Not in on_go_shared yet; field names follow
 * ChatMessage in the mobile app's chat_store.dart, with the sender as an
 * account and the photo as a link the API signs.
 */

export const ChatSenderRole = StringEnum(['client', 'mechanic'], { description: 'ChatSender.name in the mobile app' });

export const ChatMessage = Type.Object({
  id: Uuid,
  requestId: Uuid,
  senderId: Uuid,
  senderRole: ChatSenderRole,
  senderName: Type.String(),
  /** The text, or null for a photo sent without a caption. */
  body: Nullable(Type.String()),
  /** A short-lived signed link to the photo; read the thread again for a fresh one. */
  imageUrl: Nullable(Type.String()),
  replyToId: Nullable(Uuid),
  sentAt: DateTime,
});

export const ChatThread = Type.Object({
  requestId: Uuid,
  /** Whether messages can be sent: only while the job is matched. */
  open: Type.Boolean(),
  /** The other side of this match, or null before a mechanic takes the job. */
  otherPartyName: Nullable(Type.String()),
  /** Messages from the other party the caller has not read. */
  unreadCount: Type.Integer(),
  lastReadAt: Nullable(DateTime),
  /** Older messages exist: ask again with `before` set to the first message's id. */
  hasMore: Type.Boolean(),
  /** Oldest first. */
  messages: Type.Array(ChatMessage),
});

export const ChatThreadQuery = Type.Object({
  /** A message id: return the messages sent before it. */
  before: Type.Optional(Uuid),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});

export const SendChatMessageBody = Type.Object(
  {
    body: Type.String({ minLength: 1, maxLength: 2000 }),
    replyToId: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);

export const MarkChatReadBody = Type.Object(
  {
    /** Read up to this message; without it, up to the newest one. */
    upToMessageId: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);

export const ChatReadState = Type.Object({
  requestId: Uuid,
  lastReadAt: Nullable(DateTime),
  unreadCount: Type.Integer(),
});

export const ChatUnread = Type.Object({
  requestId: Uuid,
  unreadCount: Type.Integer(),
  lastMessageAt: DateTime,
});
