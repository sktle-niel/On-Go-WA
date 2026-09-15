import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { currentAuth, MOBILE_ROLES, requireAuth } from '../../auth/guard.js';
import {
  ChatMessage,
  ChatReadState,
  ChatThread,
  ChatThreadQuery,
  ChatUnread,
  MarkChatReadBody,
  SendChatMessageBody,
} from '../../schemas/chat.js';
import { errorResponses, IdParams } from '../../schemas/common.js';
import {
  getChatThread,
  listChatUnread,
  markChatRead,
  precheckChatSend,
  sendChatMessage,
  type ChatFiles,
} from '../../services/chat.service.js';
import { expireOverdueJobs } from '../../services/jobs.service.js';
import { IMAGE_TYPES } from '../../storage/storage.js';
import { badRequest } from '../../utils/errors.js';
import { consumeUpload } from '../../utils/uploads.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Job chat (Step 10 slice 8). Not in on_go_shared yet; see PROJECT.md →
 * Contract gaps. The rules live in services/chat.service.ts.
 */
export const chatRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Like every jobs route: let overdue jobs lapse first, so a chat whose job
  // just returned to the pool is already closed.
  const expireDue: preHandlerAsyncHookHandler = async () => {
    await expireOverdueJobs(app.db, app.events);
  };
  const parties = [requireAuth({ roles: MOBILE_ROLES }), expireDue];
  const files = (): ChatFiles => ({ storage: app.storage, urlTtlSeconds: app.config.FILE_URL_TTL_SECONDS });

  app.get(
    '/service-requests/:id/chat',
    {
      preHandler: parties,
      schema: {
        tags: ['Chat'],
        summary: "A job's chat",
        description:
          'Addition. The conversation between the client and the mechanic of the current match, newest ' +
          'page first with messages oldest first. `before` (a message id) pages back. Only the two parties; ' +
          '404 for anyone else. `open` says whether messages can be sent (while the job is matched).',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        querystring: ChatThreadQuery,
        response: { 200: ChatThread, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) => getChatThread(app.db, files(), currentAuth(request), request.params.id, request.query),
  );

  app.post(
    '/service-requests/:id/chat',
    {
      preHandler: parties,
      schema: {
        tags: ['Chat'],
        summary: 'Send a message',
        description:
          'Addition. Text up to 2000 characters, optionally a reply to a message in the same chat. Only while ' +
          'the job is matched (409 otherwise). Sending marks the chat read up to the new message. Publishes ' +
          '`chat_message.created` to both parties.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: SendChatMessageBody,
        response: { 201: ChatMessage, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      const dto = await sendChatMessage(app.db, app.events, files(), currentAuth(request), request.params.id, {
        body: request.body.body,
        replyToId: request.body.replyToId ?? null,
      });
      return reply.code(201).send(dto);
    },
  );

  app.post(
    '/service-requests/:id/chat/images',
    {
      preHandler: parties,
      schema: {
        tags: ['Chat'],
        summary: 'Send a photo',
        description:
          'Addition. multipart/form-data: one `file` part (JPEG/PNG/WebP, ≤ MAX_CHAT_IMAGE_BYTES), plus ' +
          'optional `body` (a caption) and `replyToId` fields sent before the file. The photo is stored ' +
          'privately and each message carries a short-lived signed `imageUrl`. Same rules as a text message.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        consumes: ['multipart/form-data'],
        response: { 201: ChatMessage, ...errorResponses(400, 401, 403, 404, 409, 413) },
      },
    },
    async (request, reply) => {
      const auth = currentAuth(request);
      // Refuse an outsider or a closed chat before reading the upload.
      await precheckChatSend(app.db, auth, request.params.id);
      const upload = await consumeUpload(request, { maxBytes: app.config.MAX_CHAT_IMAGE_BYTES, allowed: IMAGE_TYPES });
      const replyToId = upload.fields.replyToId?.trim() || null;
      if (replyToId !== null && !UUID.test(replyToId)) throw badRequest('replyToId must be a message id.');

      const stored = await app.storage.put({ kind: 'chat', ext: upload.ext, body: upload.body });
      try {
        const dto = await sendChatMessage(app.db, app.events, files(), auth, request.params.id, {
          body: upload.fields.body ?? null,
          replyToId,
          imageKey: stored.key,
        });
        return reply.code(201).send(dto);
      } catch (err) {
        // The message was refused, so the photo has nothing pointing at it.
        await app.storage.delete(stored.key).catch(() => undefined);
        throw err;
      }
    },
  );

  app.post(
    '/service-requests/:id/chat/read',
    {
      preHandler: parties,
      schema: {
        tags: ['Chat'],
        summary: 'Mark the chat read',
        description:
          'Addition. Moves the caller\'s read marker up to `upToMessageId`, or to the newest message; it never ' +
          'moves back. Send `{}` for "everything". Answers the unread count that remains.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: MarkChatReadBody,
        response: { 200: ChatReadState, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) =>
      markChatRead(app.db, currentAuth(request), request.params.id, { upToMessageId: request.body.upToMessageId }),
  );

  app.get(
    '/chat/unread',
    {
      preHandler: parties,
      schema: {
        tags: ['Chat'],
        summary: 'Jobs with unread messages',
        description:
          "Addition. The caller's jobs whose current conversation has messages they have not read, newest " +
          'first, for the app\'s chat badges.',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Array(ChatUnread), ...errorResponses(401, 403) },
      },
    },
    async (request) => listChatUnread(app.db, currentAuth(request)),
  );
};
