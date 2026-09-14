import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { WebSocket } from 'ws';
import { authenticateAccessToken, type AuthContext } from '../../auth/guard.js';
import { eventReaches } from '../../events/bus.js';
import { isAppError } from '../../utils/errors.js';

/**
 * The live channel behind every `watch*` method in the Dart contract.
 *
 * Protocol (JSON text frames):
 *
 *   client → { "type": "auth", "token": "<accessToken>" }   within 10 s of connecting
 *   server → { "type": "ready", "user": { … } }
 *   server → { "type": "event", "name": "…", "data": …, "at": "…" }   repeatedly
 *   client → { "type": "ping" }  /  server → { "type": "pong" }         optional
 *   server → { "type": "error", "code": "…", "message": "…" }  then close 4401
 *
 * The token travels in the first frame, never in the URL, so it stays out of
 * proxy and load-balancer logs. The session is re-checked on every heartbeat
 * so a sign-out or a revoked account closes the socket within one interval.
 */
export const eventRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const AUTH_TIMEOUT_MS = 10_000;

  app.get(
    '/events',
    { websocket: true, config: { rateLimit: false }, schema: { hide: true } },
    (socket: WebSocket, request) => {
      let viewer: AuthContext | null = null;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: NodeJS.Timeout | null = null;

      const send = (payload: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
      };
      const fail = (code: string, message: string) => {
        send({ type: 'error', code, message });
        socket.close(4401, code);
      };
      const cleanup = () => {
        clearTimeout(authTimer);
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unsubscribe?.();
        unsubscribe = null;
      };

      const authTimer = setTimeout(() => {
        if (!viewer) fail('unauthorized', `Send an auth frame within ${AUTH_TIMEOUT_MS / 1000} seconds.`);
      }, AUTH_TIMEOUT_MS);

      const sessionStillValid = async (): Promise<boolean> => {
        if (!viewer) return false;
        const row = await app.db.queryOne<{ active: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM sessions s
               JOIN users u ON u.id = s.user_id
              WHERE s.family_id = $1 AND s.user_id = $2
                AND s.revoked_at IS NULL AND s.expires_at > now()
                AND u.status = 'active'
           ) AS active`,
          [viewer.sessionFamilyId, viewer.userId],
        );
        return row?.active === true;
      };

      socket.on('message', (raw) => {
        void (async () => {
          let message: { type?: unknown; token?: unknown };
          try {
            message = JSON.parse(raw.toString()) as { type?: unknown; token?: unknown };
          } catch {
            send({ type: 'error', code: 'bad_request', message: 'Frames must be JSON.' });
            return;
          }

          if (message.type === 'ping') {
            send({ type: 'pong' });
            return;
          }

          if (message.type !== 'auth') {
            if (!viewer) fail('unauthorized', 'Authenticate first.');
            return;
          }
          if (viewer) return;

          if (typeof message.token !== 'string' || message.token.length === 0) {
            fail('unauthorized', 'The auth frame needs a token.');
            return;
          }

          try {
            viewer = await authenticateAccessToken(app.db, message.token);
          } catch (err) {
            fail(isAppError(err) ? err.code : 'unauthorized', isAppError(err) ? err.publicMessage : 'Unauthorized.');
            return;
          }
          clearTimeout(authTimer);

          const current = viewer;
          unsubscribe = app.events.subscribe((event) => {
            if (eventReaches(event, current)) {
              send({ type: 'event', name: event.name, data: event.data, at: event.at });
            }
          });

          heartbeat = setInterval(() => {
            void sessionStillValid().then((ok) => {
              if (!ok) {
                fail('token_invalid', 'This session has been signed out.');
                return;
              }
              if (socket.readyState === socket.OPEN) socket.ping();
            });
          }, app.config.WS_HEARTBEAT_SECONDS * 1000);

          send({
            type: 'ready',
            user: {
              accountId: current.userId,
              displayName: current.displayName,
              email: current.email,
              role: current.role,
            },
          });
        })();
      });

      socket.on('close', cleanup);
      socket.on('error', (err) => {
        request.log.warn({ err: { message: err.message } }, 'event socket error');
        cleanup();
      });
    },
  );
};
