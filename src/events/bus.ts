import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import type { TokenRole } from '../auth/tokens.js';
import { logger } from '../logging/logger.js';

/**
 * Live events.
 *
 * Every `watch*` method in the Dart contract is one subscription on one
 * socket: `/api/v1/events`. The server publishes named events here; the
 * socket route filters them per viewer and forwards them.
 *
 * Two implementations. In-memory is exact for a single instance. When
 * REDIS_URL is set the bus fans out over Redis pub/sub, so a change made on
 * instance A reaches a socket held open by instance B.
 */

export interface EventAudience {
  /** Roles that should see this. Omitted or empty = not restricted by role. */
  roles?: readonly TokenRole[];
  /** Specific users that should see this. */
  userIds?: readonly string[];
}

export interface PlatformEvent {
  name: string;
  data: unknown;
  audience?: EventAudience;
  /** ISO-8601 timestamp, set at publish time. */
  at: string;
}

export type EventHandler = (event: PlatformEvent) => void;

export interface EventBus {
  publish(event: Omit<PlatformEvent, 'at'> & { at?: string }): Promise<void>;
  subscribe(handler: EventHandler): () => void;
  close(): Promise<void>;
}

/** Whether a viewer is inside an event's audience. */
export function eventReaches(event: PlatformEvent, viewer: { userId: string; role: TokenRole }): boolean {
  const audience = event.audience;
  if (!audience) return true;
  const byUser = audience.userIds ?? [];
  const byRole = audience.roles ?? [];
  if (byUser.length === 0 && byRole.length === 0) return true;
  return byUser.includes(viewer.userId) || byRole.includes(viewer.role);
}

export function createMemoryBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    async publish(event) {
      emitter.emit('event', { ...event, at: event.at ?? new Date().toISOString() });
    },
    subscribe(handler) {
      emitter.on('event', handler);
      return () => {
        emitter.off('event', handler);
      };
    },
    async close() {
      emitter.removeAllListeners();
    },
  };
}

const CHANNEL = 'ongo:events';

export function createRedisBus(url: string): EventBus {
  const local = createMemoryBus();
  const publisher = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  const subscriber = publisher.duplicate();

  publisher.on('error', (err) => logger.error({ err: { message: err.message } }, 'redis publisher error'));
  subscriber.on('error', (err) => logger.error({ err: { message: err.message } }, 'redis subscriber error'));

  subscriber
    .subscribe(CHANNEL)
    .catch((err: Error) => logger.error({ err: { message: err.message } }, 'redis subscribe failed'));

  subscriber.on('message', (_channel: string, raw: string) => {
    try {
      const parsed = JSON.parse(raw) as PlatformEvent;
      if (typeof parsed.name === 'string' && typeof parsed.at === 'string') {
        void local.publish(parsed);
      }
    } catch {
      logger.warn('discarded malformed event from redis');
    }
  });

  return {
    async publish(event) {
      const full: PlatformEvent = { ...event, at: event.at ?? new Date().toISOString() };
      await publisher.publish(CHANNEL, JSON.stringify(full));
    },
    subscribe: local.subscribe,
    async close() {
      await local.close();
      subscriber.disconnect();
      publisher.disconnect();
    },
  };
}
