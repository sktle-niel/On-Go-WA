import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@fastify/type-provider-typebox';

const Live = Type.Object({ status: Type.Literal('ok') });
const Ready = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  database: Type.Union([Type.Literal('up'), Type.Literal('down')]),
});

/**
 * Liveness says the process is up; readiness says it can serve. A load
 * balancer should route on readiness and restart on liveness — never the
 * other way round, or a database blip restarts every task at once.
 */
export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/health/live',
    {
      config: { rateLimit: false },
      schema: { tags: ['Health'], summary: 'Liveness', response: { 200: Live } },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      config: { rateLimit: false },
      schema: { tags: ['Health'], summary: 'Readiness', response: { 200: Ready, 503: Ready } },
    },
    async (_request, reply) => {
      const up = await app.db.ping();
      if (!up) return reply.code(503).send({ status: 'degraded', database: 'down' });
      return { status: 'ok' as const, database: 'up' as const };
    },
  );
};
