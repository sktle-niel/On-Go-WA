import type { AppConfig } from '../config/env.js';
import type { CodeDelivery } from '../context.js';
import { logger } from '../logging/logger.js';
import { createSmtpDelivery } from './smtp.js';

/**
 * Where a one-time code goes. `log` is for development — it prints the code and,
 * in production, refuses to print it and reports the gap. `smtp` sends real
 * email. `createCodeDelivery` picks one from config; another driver (an HTTP
 * email API, or an SMS gateway) slots in here without touching the auth service.
 */
export function createLogDelivery(config: AppConfig): CodeDelivery {
  return {
    async deliverPasswordResetCode({ email, code, expiresInSeconds }) {
      if (config.NODE_ENV === 'production') {
        logger.error({ email }, 'password reset requested but DELIVERY_DRIVER=log — no code was sent');
        return;
      }
      logger.warn({ email, resetCode: code, expiresInSeconds }, 'DEV ONLY — password reset code (log delivery)');
    },
  };
}

export function createCodeDelivery(config: AppConfig): CodeDelivery {
  switch (config.DELIVERY_DRIVER) {
    case 'smtp':
      return createSmtpDelivery(config);
    case 'log':
    default:
      return createLogDelivery(config);
  }
}
