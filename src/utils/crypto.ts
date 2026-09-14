import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { loadConfig } from '../config/env.js';

/**
 * Small cryptographic helpers. Everything here uses the platform primitives —
 * no hand-rolled constructions.
 */

/**
 * A cryptographically random, URL-safe opaque token.
 *
 * 32 bytes = 256 bits of entropy, which puts guessing a valid refresh token
 * out of reach regardless of how many are outstanding. base64url so it
 * survives headers, cookies and JSON without escaping.
 */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newUuid(): string {
  return randomUUID();
}

/**
 * Digest used for anything we must be able to look up but must not be able to
 * read back — refresh tokens above all.
 *
 * A plain (unsalted, fast) SHA-256 is the right tool here and NOT a mistake:
 * the input is 256 bits of uniform randomness we generated, so there is no
 * dictionary to attack and nothing for a slow KDF to protect. Salting would
 * also destroy the O(1) lookup this exists for. Passwords are the opposite
 * case and go through Argon2id instead — see auth/password.ts.
 */
export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

/**
 * Keyed digest for values that are low-entropy and privacy-sensitive — IP
 * addresses and user agents. An unkeyed hash of an IPv4 address is reversible
 * by brute force in seconds (there are only ~4 billion), so the pepper is what
 * actually makes these pseudonymous.
 */
export function hmacSha256(input: string): Buffer {
  return createHmac('sha256', loadConfig().PASSWORD_PEPPER).update(input).digest();
}

/** Constant-time comparison that tolerates different lengths safely. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function safeEqualString(a: string, b: string): boolean {
  return safeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
