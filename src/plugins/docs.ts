import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { docsEnabled, type AppConfig } from '../config/env.js';

export const API_VERSION = '0.1.0';

/**
 * The OpenAPI document is generated from the route schemas, so it cannot
 * drift from what the server actually validates. It is the hand-off to the
 * front-end developer: Swagger UI at /docs while developing, and
 * `npm run openapi` writes openapi/openapi.json for client generation.
 */
export async function registerDocs(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'On Go API',
        version: API_VERSION,
        description:
          'REST API for the On Go mobile app (Client + Mechanic) and admin console ' +
          '(Admin + Moderator). Routes mirror `ApiEndpoints` in packages/on_go_shared. ' +
          'All errors use `{ "error": { "code", "message", "details"?, "requestId" } }`.',
      },
      servers: config.PUBLIC_BASE_URL ? [{ url: config.PUBLIC_BASE_URL }] : [],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'The accessToken from sign-in, refresh or register.',
          },
        },
      },
      tags: [
        { name: 'Health', description: 'Liveness and readiness' },
        { name: 'Auth', description: 'Sign in, sessions, passwords' },
        { name: 'Verification', description: 'Mechanic account verification queue' },
        { name: 'Moderators', description: 'The moderator roster and audit log (admin)' },
        { name: 'Revenue', description: 'Completed payments and platform revenue' },
        { name: 'Platform', description: 'Appearance and points policy' },
        { name: 'Jobs', description: 'Service requests, quotes, the job status machine and payment' },
        { name: 'Points', description: 'The points wallet' },
        { name: 'Locations', description: 'Last known locations and nearby jobs' },
        { name: 'Reviews', description: 'Mechanic reviews, helpful marks and the leaderboard' },
      ],
    },
  });

  if (docsEnabled(config)) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
    });
  }
}
