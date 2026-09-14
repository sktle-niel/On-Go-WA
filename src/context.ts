import type { AuthContext } from './auth/guard.js';
import type { AppConfig } from './config/env.js';
import type { Database } from './db/database.js';
import type { EventBus } from './events/bus.js';

/**
 * How a one-time code reaches a person. There is no mail or SMS provider yet;
 * the default implementation (see app.ts) logs the code outside production
 * and refuses to log it in production. Plug an email/SMS sender in here.
 */
export interface CodeDelivery {
  deliverPasswordResetCode(input: {
    email: string;
    code: string;
    expiresInSeconds: number;
  }): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    events: EventBus;
    codeDelivery: CodeDelivery;
  }
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
