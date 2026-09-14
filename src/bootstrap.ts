import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { initPasswordHashing } from './auth/password.js';
import { docsEnabled, loadConfig } from './config/env.js';
import { createPgDatabase } from './db/database.js';
import { createMemoryBus, createRedisBus } from './events/bus.js';
import { logger } from './logging/logger.js';

/**
 * Wires real infrastructure to the app and listens. Runs after remote
 * secrets are in the environment (see index.ts), which is why it is a
 * separate module: importing it validates configuration.
 */
export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  await initPasswordHashing();

  const db = createPgDatabase(config);

  const redis = config.REDIS_URL
    ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false })
    : undefined;
  redis?.on('error', (err) => logger.error({ err: { message: err.message } }, 'redis error'));

  const events = config.REDIS_URL ? createRedisBus(config.REDIS_URL) : createMemoryBus();

  const app = await buildApp({ config, db, events, redis });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    // Whatever happens, do not hang the deploy: exit within 15 s.
    setTimeout(() => process.exit(1), 15_000).unref();
    try {
      await app.close();
      await events.close();
      redis?.disconnect();
      await db.close();
      // No process.exit(0): with everything closed the event loop drains and
      // the process ends on its own, after the logger has flushed.
    } catch (err) {
      app.log.error({ err: { message: (err as Error).message } }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });

  const ready = await db.ping();
  app.log.info(
    {
      env: config.NODE_ENV,
      database: ready ? 'up' : 'DOWN — check PG* settings',
      redis: config.REDIS_URL ? 'configured' : 'not configured (single instance)',
      docs: docsEnabled(config) ? '/docs' : 'disabled',
    },
    'on go api ready',
  );
}
