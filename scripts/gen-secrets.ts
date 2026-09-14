import { randomBytes } from 'node:crypto';

/**
 * Prints fresh values for the secrets .env needs. Paste them into .env
 * locally, or into Secrets Manager for a deployed environment. Never commit.
 */
const value = (bytes: number) => randomBytes(bytes).toString('base64url');

console.log(`JWT_SIGNING_KEY=${value(48)}`);
console.log(`PASSWORD_PEPPER=${value(32)}`);
console.log('# When rotating JWT_SIGNING_KEY, move the old value here for one token lifetime:');
console.log('# JWT_PREVIOUS_SIGNING_KEY=');
