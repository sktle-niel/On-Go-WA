import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { currentAuth, requireAuth } from '../../auth/guard.js';
import { extractBearerToken } from '../../auth/tokens.js';
import {
  Accepted,
  AccessToken,
  AuthSession,
  ChangePasswordBody,
  MeResponse,
  RegisterBody,
  ResetConfirmBody,
  ResetRequestBody,
  SignInBody,
} from '../../schemas/auth.js';
import { errorResponses, NoContent } from '../../schemas/common.js';
import {
  changePassword,
  confirmPasswordReset,
  refresh,
  register,
  requestPasswordReset,
  signIn,
  signOut,
  type AuthDeps,
  type RequestMeta,
  type SessionBundle,
} from '../../services/auth.service.js';
import { badRequest, unauthorized } from '../../utils/errors.js';
import { clientIpHash, userAgentHash } from '../../utils/ip.js';

/** The refresh cookie is scoped to these routes and nowhere else. */
const COOKIE_PATH = '/api/v1/auth';

export const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const config = app.config;
  const authLimit = {
    rateLimit: {
      max: config.RATE_LIMIT_AUTH_MAX,
      timeWindow: config.RATE_LIMIT_AUTH_WINDOW_SECONDS * 1000,
    },
  };
  const deps = (): AuthDeps => ({ db: app.db, config, codeDelivery: app.codeDelivery });
  const meta = (request: FastifyRequest): RequestMeta => ({
    ipHash: clientIpHash(request),
    userAgentHash: userAgentHash(request),
    requestId: request.id,
  });

  const cookieOptions = (expiresAt: Date) => ({
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: config.REFRESH_COOKIE_SAMESITE,
    path: COOKIE_PATH,
    maxAge: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    ...(config.REFRESH_COOKIE_DOMAIN ? { domain: config.REFRESH_COOKIE_DOMAIN } : {}),
  });

  /**
   * The console gets its refresh token as an httpOnly cookie, which a script
   * injected into the page cannot read. The mobile app gets it in the body and
   * keeps it in the platform keystore. Neither surface gets both.
   */
  function respond(reply: FastifyReply, bundle: SessionBundle, status: number) {
    const body = {
      user: { ...bundle.user, accountId: bundle.user.accountId },
      permissions: bundle.permissions,
      accessToken: bundle.accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: bundle.expiresIn,
    };
    if (bundle.surface === 'console') {
      void reply.setCookie(config.REFRESH_COOKIE_NAME, bundle.refreshToken, cookieOptions(bundle.refreshExpiresAt));
      return reply.code(status).send(body);
    }
    return reply.code(status).send({ ...body, refreshToken: bundle.refreshToken });
  }

  /** Refresh token from the JSON body (mobile) or the cookie (console). */
  function presentedRefreshToken(request: FastifyRequest): string | null {
    const body = (request.body ?? {}) as { refreshToken?: unknown };
    if (body.refreshToken !== undefined) {
      if (typeof body.refreshToken !== 'string' || body.refreshToken.length === 0 || body.refreshToken.length > 512) {
        throw badRequest('refreshToken must be a non-empty string.');
      }
      return body.refreshToken;
    }
    const cookie = request.cookies[config.REFRESH_COOKIE_NAME];
    return typeof cookie === 'string' && cookie.length > 0 ? cookie : null;
  }

  app.post(
    '/sign-in',
    {
      config: authLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Sign in',
        description:
          'AuthApi.signIn. A console role signing in from the mobile surface (or the reverse) ' +
          'is refused with `wrong_surface`. Repeated failures lock the account for a while.',
        body: SignInBody,
        response: { 200: AuthSession, ...errorResponses(400, 401, 403, 423, 429) },
      },
    },
    async (request, reply) => {
      const bundle = await signIn(deps(), request.body, meta(request));
      return respond(reply, bundle, 200);
    },
  );

  app.post(
    '/register',
    {
      config: authLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Register a client or mechanic',
        description:
          'Not in on_go_shared yet (the mobile app registers in-session today). Creates the ' +
          'account and signs it in. A mechanic then files a verification request separately.',
        body: RegisterBody,
        response: { 201: AuthSession, ...errorResponses(400, 409, 429) },
      },
    },
    async (request, reply) => {
      const bundle = await register(deps(), request.body, meta(request));
      return respond(reply, bundle, 201);
    },
  );

  app.post(
    '/refresh',
    {
      config: authLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Rotate the refresh token and get a new access token',
        description:
          'Body: `{ "refreshToken": "..." }` on mobile; the console sends an empty body and the ' +
          'cookie travels with it. Every refresh token works ONCE — reusing an old one signs the ' +
          'whole session out, because it means two parties hold it.',
        response: { 200: AuthSession, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (request, reply) => {
      const token = presentedRefreshToken(request);
      if (!token) throw unauthorized('A refresh token is required.');
      const bundle = await refresh(deps(), { refreshToken: token }, meta(request));
      return respond(reply, bundle, 200);
    },
  );

  app.post(
    '/sign-out',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign out',
        description:
          'AuthApi.signOut. Revokes the session on every device that shares it. Accepts the ' +
          'bearer token, the refresh token (body or cookie), or both; always succeeds.',
        security: [{ bearerAuth: [] }],
        response: { 204: NoContent, ...errorResponses(400) },
      },
    },
    async (request, reply) => {
      await signOut(
        deps(),
        {
          accessToken: extractBearerToken(request.headers.authorization),
          refreshToken: presentedRefreshToken(request),
        },
        meta(request),
      );
      void reply.clearCookie(config.REFRESH_COOKIE_NAME, { path: COOKIE_PATH });
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/me',
    {
      preHandler: [requireAuth()],
      schema: {
        tags: ['Auth'],
        summary: 'Who am I',
        description: 'The account behind the bearer token, with current permissions. Use it to restore a session on launch.',
        security: [{ bearerAuth: [] }],
        response: { 200: MeResponse, ...errorResponses(401, 403) },
      },
    },
    async (request) => {
      const auth = currentAuth(request);
      return {
        user: { accountId: auth.userId, displayName: auth.displayName, email: auth.email, role: auth.role },
        permissions: auth.permissions,
      };
    },
  );

  app.post(
    '/password',
    {
      preHandler: [requireAuth()],
      schema: {
        tags: ['Auth'],
        summary: 'Change password',
        description:
          'AuthApi.changePassword. Signs every other device out. Replace the stored access ' +
          'token with the one returned: the change retires all tokens issued before it.',
        security: [{ bearerAuth: [] }],
        body: ChangePasswordBody,
        response: { 200: AccessToken, ...errorResponses(400, 401) },
      },
    },
    async (request) => {
      const result = await changePassword(deps(), currentAuth(request), request.body, meta(request));
      return { ...result, tokenType: 'Bearer' as const };
    },
  );

  app.post(
    '/password/reset',
    {
      config: authLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Request a password reset code',
        description:
          'Step 1 of AuthApi.resetPassword. Always answers 202, whether or not the email exists. ' +
          'Delivery is a pluggable provider; without one the code is logged (dev only).',
        body: ResetRequestBody,
        response: { 202: Accepted, ...errorResponses(400, 429) },
      },
    },
    async (request, reply) => {
      await requestPasswordReset(deps(), request.body, meta(request));
      return reply.code(202).send({
        status: 'accepted' as const,
        message: 'If that email has an account, a code is on its way.',
      });
    },
  );

  app.post(
    '/password/reset/confirm',
    {
      config: authLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Set a new password with the code',
        description: 'Step 2 of AuthApi.resetPassword. Signs the account out everywhere on success.',
        body: ResetConfirmBody,
        response: { 204: NoContent, ...errorResponses(400, 429) },
      },
    },
    async (request, reply) => {
      await confirmPasswordReset(deps(), request.body, meta(request));
      return reply.code(204).send(null);
    },
  );
};
