import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../utils/errors.js';

/**
 * The HTTP hardening layer, in one place so it can be read as a checklist:
 *
 *   helmet          security headers (HSTS in production, nosniff, frameguard…)
 *   cors            exact-origin allowlist; credentials allowed for the console
 *   cookie          the console's httpOnly refresh cookie
 *   rate-limit      per-IP budget, shared through Redis when configured
 *   under-pressure  sheds load with 503 instead of falling over
 *
 * What sits in front of this in production — WAF, TLS termination, the
 * ALB — is documented in the README; nothing here assumes it is absent.
 */
export async function registerSecurity(
  app: FastifyInstance,
  config: AppConfig,
  redis?: Redis,
): Promise<void> {
  await app.register(helmet, {
    // This is a JSON API; a CSP only governs HTML we do not serve (Swagger UI
    // aside, which ships its own inline scripts and would be blocked by one).
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: config.NODE_ENV === 'production' ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  const allowed = new Set(config.CORS_ALLOWED_ORIGINS);
  const localhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
  await app.register(cors, {
    origin: (origin, callback) => {
      // No Origin header: a native app, curl, or a server. CORS does not apply.
      if (!origin) return callback(null, true);
      // Outside production an empty allowlist means "any origin", so a
      // developer's Flutter web build on a random port just works.
      if (allowed.size === 0 && config.NODE_ENV !== 'production') return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      // Staging: a developer's local web build against the deployed API.
      if (config.CORS_ALLOW_LOCALHOST && localhost.test(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
    maxAge: 600,
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_SECONDS * 1000,
    ...(redis ? { redis } : {}),
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (request, context) => ({
      error: {
        code: 'rate_limited',
        message: `Too many requests. Try again in ${context.after}.`,
        requestId: request.id,
      },
    }),
  });

  await app.register(underPressure, {
    maxEventLoopDelay: config.LOAD_SHED_MAX_EVENT_LOOP_DELAY_MS,
    maxEventLoopUtilization: config.LOAD_SHED_MAX_EVENT_LOOP_UTILIZATION,
    retryAfter: 2,
    // under-pressure instantiates this itself, so it needs the class.
    customError: ServiceBusyError,
  });
}

class ServiceBusyError extends AppError {
  constructor() {
    super('service_unavailable', 'The service is busy. Please try again shortly.');
  }
}
