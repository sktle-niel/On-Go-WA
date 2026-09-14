import type { FastifyError, FastifyInstance } from 'fastify';
import { isAppError } from '../utils/errors.js';

/**
 * Turns every failure into the one error envelope the clients parse:
 *
 *   { "error": { "code", "message", "details"?, "requestId" } }
 *
 * AppErrors carry their own status and public message. Fastify's own 4xx
 * errors (validation, bad JSON, body too large) are safe to relay. Anything
 * else is a 500 with a fixed message — the real error goes to the log under
 * the request id, which is what the caller is told to quote.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: {
        code: 'not_found',
        message: `No route for ${request.method} ${request.url.split('?')[0]}.`,
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    if (isAppError(error)) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error.cause ?? error, ...error.logContext }, error.code);
      } else if (error.logContext) {
        request.log.info({ ...error.logContext }, error.code);
      }
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.publicMessage,
          ...(error.details !== undefined ? { details: error.details } : {}),
          requestId,
        },
      });
    }

    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: `Invalid ${error.validationContext ?? 'request'}.`,
          details: error.validation.map((issue) => ({
            path: issue.instancePath || String(issue.params?.missingProperty ?? ''),
            message: issue.message ?? 'is invalid',
          })),
          requestId,
        },
      });
    }

    if (error.statusCode === 413) {
      return reply.code(413).send({
        error: { code: 'payload_too_large', message: 'Request body is too large.', requestId },
      });
    }

    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.statusCode === 429 ? 'rate_limited' : 'bad_request',
          message: error.message,
          requestId,
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        message: 'Something went wrong. Please try again.',
        requestId,
      },
    });
  });
}
