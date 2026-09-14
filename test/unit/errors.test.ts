import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, internalError, isAppError, isUniqueViolation, notFound } from '../../src/utils/errors.js';

test('codes map to the intended HTTP status', () => {
  assert.equal(notFound().statusCode, 404);
  assert.equal(new AppError('account_locked', 'x').statusCode, 423);
  assert.equal(new AppError('wrong_surface', 'x').statusCode, 403);
  assert.equal(new AppError('not_implemented', 'x').statusCode, 501);
});

test('internal errors keep the cause for the log and a fixed public message', () => {
  const cause = new Error('duplicate key value violates unique constraint users_email_lower_key');
  const err = internalError(cause, { stage: 'query' });
  assert.equal(err.publicMessage, 'Something went wrong. Please try again.');
  assert.equal(err.cause, cause);
  assert.ok(isAppError(err));
});

test('detects a unique violation through the db wrapper', () => {
  const driverError = Object.assign(new Error('dup'), { code: '23505' });
  assert.equal(isUniqueViolation(driverError), true);
  assert.equal(isUniqueViolation(internalError(driverError)), true);
  assert.equal(isUniqueViolation(new Error('other')), false);
});
