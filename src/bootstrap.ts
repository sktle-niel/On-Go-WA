import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { initPasswordHashing } from './auth/password.js';
import { docsEnabled, loadConfig } from './config/env.js';
import { createPgDatabase } from './db/database.js';
import { createMemoryBus, createRedisBus } from './events/bus.js';
import { logger } from './logging/logger.js';
import { expireOverdueJobs } from './services/jobs.service.js';
import { createStorage } from './storage/storage.js';

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
  const storage = createStorage(config);
  if (config.NODE_ENV === 'production' && config.STORAGE_DRIVER === 'disk') {
    logger.warn('uploads are on the container disk, which a restart or a new revision empties; set STORAGE_DRIVER=gcs');
  }

  const app = await buildApp({ config, db, events, redis, storage });

  let sweepTimer: NodeJS.Timeout | undefined;
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    // Whatever happens, do not hang the deploy: exit within 15 s.
    setTimeout(() => process.exit(1), 15_000).unref();
    if (sweepTimer) clearInterval(sweepTimer);
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

  // The completion clock: overdue jobs lapse and their parties hear it even when
  // nobody is calling the jobs routes (which also sweep before they run).
  if (config.JOB_EXPIRY_SWEEP_SECONDS > 0) {
    const sweep = () =>
      expireOverdueJobs(db, events).catch((err: unknown) =>
        app.log.error({ err: { message: (err as Error).message } }, 'job expiry sweep failed'),
      );
    void sweep();
    sweepTimer = setInterval(() => void sweep(), config.JOB_EXPIRY_SWEEP_SECONDS * 1000);
    sweepTimer.unref();
  }
}
