import '../helpers/env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { extractBearerToken, issueAccessToken, verifyAccessToken } from '../../src/auth/tokens.js';
import { newUuid } from '../../src/utils/crypto.js';
import { isAppError } from '../../src/utils/errors.js';

const userId = newUuid();
const sessionFamilyId = newUuid();

test('issues a token whose claims verify', async () => {
  const { token, expiresIn } = await issueAccessToken({ userId, role: 'client', sessionFamilyId });
  assert.equal(expiresIn, 600);
  const claims = await verifyAccessToken(token);
  assert.equal(claims.sub, userId);
  assert.equal(claims.role, 'client');
  assert.equal(claims.sid, sessionFamilyId);
  assert.equal(claims.exp - claims.iat, 600);
});

test('a tampered token is invalid', async () => {
  const { token } = await issueAccessToken({ userId, role: 'client', sessionFamilyId });
  const [header, payload, signature] = token.split('.');
  const forged = `${header}.${payload}.${signature?.slice(0, -2)}AA`;
  await assert.rejects(verifyAccessToken(forged), (err) => isAppError(err) && err.code === 'token_invalid');
});

test('an expired token reports token_expired, not token_invalid', async () => {
  const key = new TextEncoder().encode(process.env.JWT_SIGNING_KEY);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ role: 'client', sid: sessionFamilyId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer('ongo-api')
    .setAudience('ongo-app')
    .setIssuedAt(now - 700)
    .setExpirationTime(now - 100)
    .setJti(newUuid())
    .sign(key);
  await assert.rejects(verifyAccessToken(token), (err) => isAppError(err) && err.code === 'token_expired');
});

test('a token with the wrong audience is invalid', async () => {
  const key = new TextEncoder().encode(process.env.JWT_SIGNING_KEY);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ role: 'admin', sid: sessionFamilyId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer('ongo-api')
    .setAudience('someone-else')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(newUuid())
    .sign(key);
  await assert.rejects(verifyAccessToken(token), (err) => isAppError(err) && err.code === 'token_invalid');
});

test('extracts bearer tokens strictly', () => {
  assert.equal(extractBearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(extractBearerToken('bearer abc'), null);
  assert.equal(extractBearerToken('Basic abc'), null);
  assert.equal(extractBearerToken(undefined), null);
});
