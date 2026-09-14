import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { bearer, createTestApp, createUser, signInAs, type TestContext } from '../helpers/app.js';

let ctx: TestContext;

before(async () => {
  ctx = await createTestApp();
});

after(async () => {
  await ctx.close();
});

const email = 'ana.cruz@example.com';
const password = 'correct horse battery';

describe('registration and sign-in (mobile)', () => {
  test('registers a client and returns a mobile session with the refresh token in the body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'Ana.Cruz@Example.com', password, firstName: 'Ana', lastName: 'Cruz', role: 'client' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.user.email, email);
    assert.equal(body.user.displayName, 'Ana Cruz');
    assert.equal(body.user.role, 'client');
    assert.equal(body.tokenType, 'Bearer');
    assert.equal(body.expiresIn, 600);
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
    assert.deepEqual(body.permissions, {
      canApprove: false,
      canReject: false,
      canEscalate: false,
      canChangeBackground: false,
    });
    assert.equal(res.cookies.length, 0);
  });

  test('a duplicate email is a 409', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password, firstName: 'Ana', role: 'client' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'conflict');
  });

  test('validation failures use the envelope with field details', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { identifier: email, surface: 'mobile' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, 'validation_failed');
    assert.ok(Array.isArray(body.error.details));
    assert.ok(body.error.requestId);
  });

  test('wrong password and unknown account are indistinguishable', async () => {
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { identifier: email, password: 'nope nope nope', surface: 'mobile' },
    });
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { identifier: 'nobody@example.com', password: 'nope nope nope', surface: 'mobile' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(wrong.json().error.code, unknown.json().error.code);
    assert.deepEqual(wrong.json().error.message, unknown.json().error.message);
  });

  test('a mobile role signing in on the console surface is refused with wrong_surface', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { identifier: email, password, surface: 'console' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'wrong_surface');
  });

  test('me returns the account behind the token', async () => {
    const session = await signInAs(ctx.app, email, password, 'mobile');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session.accessToken) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.email, email);
    assert.equal(res.json().user.role, 'client');
  });

  test('me without a token is 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'unauthorized');
  });
});

describe('lockout', () => {
  test('locks the account after the configured failures, even for the right password', async () => {
    await createUser(ctx.db, { email: 'locky@example.com', password: 'right password 1', role: 'client' });
    for (let i = 0; i < 3; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        payload: { identifier: 'locky@example.com', password: 'wrong', surface: 'mobile' },
      });
      assert.equal(res.statusCode, 401);
    }
    const locked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { identifier: 'locky@example.com', password: 'right password 1', surface: 'mobile' },
    });
    assert.equal(locked.statusCode, 423);
    assert.equal(locked.json().error.code, 'account_locked');
  });
});

describe('refresh rotation', () => {
  test('rotates the refresh token and revokes the family on reuse', async () => {
    const session = await signInAs(ctx.app, email, password, 'mobile');
    assert.ok(session.refreshToken);

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    assert.equal(first.statusCode, 200, first.body);
    const rotated = first.json();
    assert.ok(rotated.refreshToken);
    assert.notEqual(rotated.refreshToken, session.refreshToken);
    assert.ok(rotated.accessToken);

    // The new access token works.
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(rotated.accessToken) });
    assert.equal(me.statusCode, 200);

    // Replaying the OLD refresh token is reuse: the whole family dies.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error.code, 'token_invalid');

    const afterReuse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });
    assert.equal(afterReuse.statusCode, 401);

    const meAfter = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(rotated.accessToken) });
    assert.equal(meAfter.statusCode, 401);

    const events = await ctx.db.queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_events WHERE event = 'auth.token.reuse_detected'`,
    );
    assert.equal(events?.n, 1);
  });

  test('refresh without any token is 401', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: {} });
    assert.equal(res.statusCode, 401);
  });
});

describe('password change', () => {
  test('returns a fresh access token and retires the old one', async () => {
    const session = await signInAs(ctx.app, email, password, 'mobile');
    const other = await signInAs(ctx.app, email, password, 'mobile');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: bearer(session.accessToken),
      payload: { currentPassword: password, newPassword: 'a brand new password' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const fresh = res.json();
    assert.ok(fresh.accessToken);

    const old = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session.accessToken) });
    assert.equal(old.statusCode, 401);
    const now = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(fresh.accessToken) });
    assert.equal(now.statusCode, 200);

    // The other device's session was revoked.
    const otherRefresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: other.refreshToken },
    });
    assert.equal(otherRefresh.statusCode, 401);

    // And the new password signs in.
    const again = await signInAs(ctx.app, email, 'a brand new password', 'mobile');
    assert.ok(again.accessToken);
  });

  test('the wrong current password is refused', async () => {
    const session = await signInAs(ctx.app, email, 'a brand new password', 'mobile');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: bearer(session.accessToken),
      payload: { currentPassword: 'not it', newPassword: 'another new password' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'invalid_credentials');
  });
});

describe('password reset', () => {
  test('issues a code, rejects a wrong one, accepts the right one', async () => {
    const request = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { email },
    });
    assert.equal(request.statusCode, 202);

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { email: 'nobody@example.com' },
    });
    assert.equal(unknown.statusCode, 202);
    assert.deepEqual(unknown.json(), request.json());

    const delivered = ctx.resetCodes.at(-1);
    assert.ok(delivered);
    assert.equal(delivered.email, email);
    assert.match(delivered.code, /^[0-9]{6}$/);

    const wrongCode = delivered.code === '000000' ? '111111' : '000000';
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/confirm',
      payload: { email, code: wrongCode, newPassword: 'reset password one' },
    });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error.code, 'invalid_reset_code');

    const right = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/confirm',
      payload: { email, code: delivered.code, newPassword: 'reset password one' },
    });
    assert.equal(right.statusCode, 204, right.body);

    const reused = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/confirm',
      payload: { email, code: delivered.code, newPassword: 'reset password two' },
    });
    assert.equal(reused.statusCode, 400);

    const session = await signInAs(ctx.app, email, 'reset password one', 'mobile');
    assert.ok(session.accessToken);
  });
});

describe('sign-out', () => {
  test('revokes the session for the bearer token', async () => {
    const session = await signInAs(ctx.app, email, 'reset password one', 'mobile');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: bearer(session.accessToken),
    });
    assert.equal(res.statusCode, 204);

    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session.accessToken) });
    assert.equal(me.statusCode, 401);
    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    assert.equal(refresh.statusCode, 401);

    // Signing out again is harmless.
    const again = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers: bearer(session.accessToken) });
    assert.equal(again.statusCode, 204);
  });
});

describe('console surface', () => {
  const adminEmail = 'admin@example.com';
  const adminPassword = 'admin password 123';

  test('an admin gets the refresh token as an httpOnly cookie, not in the body', async () => {
    await createUser(ctx.db, { email: adminEmail, password: adminPassword, role: 'admin', firstName: 'Ada', lastName: 'Admin' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { identifier: adminEmail, password: adminPassword, surface: 'console' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.user.role, 'admin');
    assert.equal(body.refreshToken, undefined);
    assert.deepEqual(body.permissions, {
      canApprove: true,
      canReject: true,
      canEscalate: true,
      canChangeBackground: true,
    });
    const cookie = res.cookies.find((c) => c.name === 'ongo_refresh');
    assert.ok(cookie, 'refresh cookie missing');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.path, '/api/v1/auth');
    assert.equal(cookie.sameSite, 'Lax');
  });

  test('refresh and sign-out work from the cookie alone', async () => {
    const session = await signInAs(ctx.app, adminEmail, adminPassword, 'console');
    assert.ok(session.cookie);

    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { ongo_refresh: session.cookie },
      payload: {},
    });
    assert.equal(refresh.statusCode, 200, refresh.body);
    assert.equal(refresh.json().refreshToken, undefined);
    const rotatedCookie = refresh.cookies.find((c) => c.name === 'ongo_refresh');
    assert.ok(rotatedCookie);
    assert.notEqual(rotatedCookie.value, session.cookie);

    const signOut = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      cookies: { ongo_refresh: rotatedCookie.value },
    });
    assert.equal(signOut.statusCode, 204);
    const cleared = signOut.cookies.find((c) => c.name === 'ongo_refresh');
    assert.ok(cleared);
    assert.equal(cleared.value, '');

    const afterSignOut = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: bearer(refresh.json().accessToken),
    });
    assert.equal(afterSignOut.statusCode, 401);
  });

  test('a console role on the mobile surface is refused with wrong_surface', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { identifier: adminEmail, password: adminPassword, surface: 'mobile' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'wrong_surface');
  });
});
