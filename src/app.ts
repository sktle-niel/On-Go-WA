import multipart from '@fastify/multipart';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { AppConfig } from './config/env.js';
import type { CodeDelivery } from './context.js';
import { createCodeDelivery } from './delivery/code-delivery.js';
import type { Database } from './db/database.js';
import type { EventBus } from './events/bus.js';
import { createStorage, type Storage } from './storage/storage.js';
import { logger } from './logging/logger.js';
import { registerDocs } from './plugins/docs.js';
import { registerErrorHandling } from './plugins/errors.js';
import { registerSecurity } from './plugins/security.js';
import { healthRoutes } from './routes/health.js';
import { v1Routes } from './routes/v1/index.js';
import { newUuid } from './utils/crypto.js';
import './context.js';

export interface AppDeps {
  config: AppConfig;
  db: Database;
  events: EventBus;
  redis?: Redis;
  codeDelivery?: CodeDelivery;
  storage?: Storage;
}

/**
 * Builds the HTTP application without starting it. `bootstrap.ts` gives it
 * real infrastructure and listens; tests give it an in-memory database and
 * use `app.inject()`. Same code path either way.
 */
export async function buildApp(deps: AppDeps) {
  const { config } = deps;

  const base = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Trust exactly TRUST_PROXY_HOPS proxies (hop 0 is the socket peer). With
    // zero hops, X-Forwarded-For is ignored and a client cannot spoof its IP.
    trustProxy:
      config.TRUST_PROXY_HOPS > 0
        ? (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS
        : false,
    bodyLimit: config.MAX_REQUEST_BODY_BYTES,
    // Never trust a caller-supplied request id: it lands in every log line.
    requestIdHeader: false,
    genReqId: () => newUuid(),
    disableRequestLogging: config.NODE_ENV === 'test',
    ajv: {
      customOptions: {
        removeAdditional: true,
        useDefaults: true,
        coerceTypes: 'array',
        allErrors: false,
      },
    },
  });

  base.decorate('config', config);
  base.decorate('db', deps.db);
  base.decorate('events', deps.events);
  base.decorate('codeDelivery', deps.codeDelivery ?? createCodeDelivery(config));
  base.decorate('storage', deps.storage ?? createStorage(config));

  registerErrorHandling(base);
  await registerDocs(base, config);
  await registerSecurity(base, config, deps.redis);
  await base.register(websocket, { options: { maxPayload: 16 * 1024 } });
  // Uploads: one file per request; the plugin caps bytes at the larger limit
  // and each route enforces its own (documents vs the smaller background).
  await base.register(multipart, {
    limits: { fileSize: config.MAX_DOCUMENT_BYTES, files: 1, fields: 20 },
  });

  // Same instance, typed for TypeBox schemas from here on.
  const app = base.withTypeProvider<TypeBoxTypeProvider>();
  await app.register(healthRoutes);
  await app.register(v1Routes, { prefix: '/api/v1' });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
