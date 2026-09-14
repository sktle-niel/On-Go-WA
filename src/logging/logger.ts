import { pino, type Logger } from 'pino';
import { loadConfig } from '../config/env.js';

/**
 * Application logger.
 *
 * Redaction here is a backstop, not the strategy — the rule is that secrets
 * are never handed to the logger in the first place. The paths below catch the
 * cases where a whole object gets logged by accident (a request body, a config
 * dump, a database row) so a mistake degrades to `[redacted]` instead of
 * writing a password or token into CloudWatch, where it would then have to be
 * treated as disclosed and rotated.
 */

const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'passwordHash',
  'password_hash',
  'pepper',
  'token',
  'accessToken',
  'refreshToken',
  'refresh_token',
  'refreshTokenHash',
  'secret',
  'authorization',
  'cookie',
  'setCookie',
  'apiKey',
  'sessionToken',
];

/** Same leaf names, but wherever they appear in these common containers. */
function expand(paths: string[]): string[] {
  const containers = [
    '',
    'req.headers.',
    'req.body.',
    'body.',
    'headers.',
    'res.headers.',
    'err.',
    'context.',
    '*.',
  ];
  const out = new Set<string>();
  for (const container of containers) {
    for (const leaf of paths) out.add(`${container}${leaf}`);
  }
  return [...out];
}

const config = loadConfig();

export const logger: Logger = pino({
  level: config.LOG_LEVEL,
  base: {
    service: 'ongo-api',
    env: config.NODE_ENV,
  },
  redact: {
    paths: expand(REDACTED_PATHS),
    censor: '[redacted]',
  },
  // Structured JSON in production so CloudWatch Logs Insights can query it;
  // readable output locally.
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: {
    // Never serialize the full request: no bodies, no query strings, no
    // headers beyond the ones we deliberately name.
    req(request: { method?: string; url?: string; id?: string }) {
      return {
        id: request.id,
        method: request.method,
        // Strip the query string — it can carry identifiers or, if a client
        // misbehaves, a token.
        url: typeof request.url === 'string' ? request.url.split('?')[0] : undefined,
      };
    },
    res(reply: { statusCode?: number }) {
      return { statusCode: reply.statusCode };
    },
  },
});
