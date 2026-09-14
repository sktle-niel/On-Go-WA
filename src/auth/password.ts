import { argon2id, hash, needsRehash as argonNeedsRehash, verify, type HashOptions } from 'argon2';
import { loadConfig } from '../config/env.js';
import { logger } from '../logging/logger.js';

/**
 * Password hashing.
 *
 * Argon2id, which is what OWASP recommends over bcrypt for new work: it is
 * memory-hard, so an attacker with GPUs or ASICs gains far less than they do
 * against bcrypt's small fixed memory footprint. `id` is the hybrid variant —
 * Argon2i's side-channel resistance for the first pass, Argon2d's
 * GPU-resistance for the rest.
 *
 * Parameters default to 64 MiB / t=3 / p=1, above the OWASP floor of
 * 19 MiB / t=2 / p=1, and are configurable so they can be raised as hardware
 * improves. Raising them is safe: the cost parameters are encoded in each
 * stored hash, so old hashes keep verifying and are upgraded on next login
 * (see `needsRehash`).
 *
 * A server-side pepper is mixed in via Argon2's `secret` parameter. It lives
 * in Secrets Manager, never in the database, so an attacker holding only a
 * dumped `users` table cannot mount an offline cracking run at all — they are
 * missing a key input. Rotating the pepper invalidates every hash, so it is
 * changed only alongside a forced password reset.
 */

function options(): HashOptions {
  const config = loadConfig();
  return {
    type: argon2id,
    memoryCost: config.ARGON2_MEMORY_KIB,
    timeCost: config.ARGON2_TIME_COST,
    parallelism: config.ARGON2_PARALLELISM,
    secret: Buffer.from(config.PASSWORD_PEPPER, 'utf8'),
  };
}

/**
 * A pre-computed hash of a random value, used to burn the same CPU time on a
 * login for an account that does not exist as one that does. Without it, "user
 * not found" returns in ~0 ms and "wrong password" in ~50 ms, and that gap is
 * a reliable account-enumeration oracle no matter how carefully the error
 * messages are worded.
 */
let dummyHash: string | null = null;

export async function initPasswordHashing(): Promise<void> {
  // Computed once at boot so the first login is not slower than the rest.
  dummyHash = await hash('password-that-is-never-valid-' + Math.random().toString(36), options());
}

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, options());
}

/**
 * Verifies a password. Returns false on ANY failure, including a malformed or
 * truncated stored hash — a corrupt row must never authenticate someone.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, {
      secret: Buffer.from(loadConfig().PASSWORD_PEPPER, 'utf8'),
    });
  } catch (err) {
    logger.warn({ err: { message: (err as Error).message } }, 'password verification failed to run');
    return false;
  }
}

/**
 * Spends the same time verifying as a real check would, then fails. Call this
 * on the "no such user" branch of login.
 */
export async function verifyDummyPassword(plaintext: string): Promise<false> {
  if (!dummyHash) {
    await initPasswordHashing();
  }
  await verifyPassword(dummyHash as string, plaintext);
  return false;
}

/**
 * True when a stored hash was produced with weaker parameters than the current
 * configuration — i.e. the cost settings were raised since the user last
 * logged in. The caller re-hashes transparently at login, when it holds the
 * plaintext anyway.
 */
export function needsRehash(storedHash: string): boolean {
  try {
    const { memoryCost, timeCost, parallelism } = options();
    return argonNeedsRehash(storedHash, { memoryCost, timeCost, parallelism });
  } catch {
    // Unparseable hash (e.g. a legacy bcrypt row) — treat as needing an
    // upgrade rather than silently leaving it in place.
    return true;
  }
}
