# Security

This repository is public. It contains code and documentation only. **No
credential, key, token or password is ever committed**, and every commit and
push is checked for that automatically. This file says how, what the running
service protects, and what to do if something slips.

## Reporting a vulnerability

Email the repository owner (see the GitHub profile) with the details and, if
possible, a reproduction. Please do not open a public issue for a security
problem. You will get an acknowledgement within a few days.

## Where secrets live

| Secret | Lives in | Never in |
| --- | --- | --- |
| JWT signing key, password pepper, database password | Google Secret Manager (`ongo-jwt-signing-key`, `ongo-password-pepper`, `ongo-pg-password`), injected into Cloud Run with `--set-secrets` | the repo, the container image, `--set-env-vars`, logs, chat, docs |
| Local development values | `.env` (git-ignored, docker-ignored, gcloud-ignored) | the repo |
| Staging values for laptop-run scripts | `.env.cloud` (git-ignored, ACL-restricted to the owner) | the repo |
| Admin credentials | the owner's password manager | anywhere else |

Rules that keep it that way:

- `.env`, `.env.*` (except `.env.example`), key and certificate files, SSH
  keys and cloud credential JSON files are refused by the pre-commit hook and
  ignored by git, Docker and gcloud.
- `.env.example` and the docs hold **no values that look like secrets**: a
  setting is left empty or written as `<what to put here>`. Secret scanners
  (GitGuardian on GitHub, gitleaks in CI, `scripts/check-secrets.mjs` locally)
  flag anything else, and a flag on a placeholder costs the same attention as
  a real leak.
- Secrets are generated into shell variables or files and piped into Secret
  Manager or an env file; they are never pasted into a terminal command that
  ends up in shell history, a document, a commit message or tool output.
- The seed script reads the admin password from `SEED_ADMIN_PASSWORD`, not
  from the command line.

## Checks on every commit and push

Enabled automatically by `npm install` (`scripts/setup-hooks.mjs` sets
`core.hooksPath` to `.githooks`). To enable by hand: `git config core.hooksPath .githooks`.

| When | What runs | Blocks on |
| --- | --- | --- |
| `git commit` | `scripts/check-secrets.mjs --staged` | a forbidden file, a known credential shape (private key, AWS/Google/GitHub/Slack/Stripe/Mailgun/SendGrid/Twilio/Neon keys, JWTs, connection URLs with passwords), or a `password=` / `secret=` / `token=` / `key=` assignment with a non-placeholder value |
| `git push` | the same scan over every tracked file, then `npm run typecheck`, `npm test`, `npm audit --audit-level=high` | any failure |
| GitHub Actions (push to `main` or `development`, every PR) | `npm ci`, typecheck, tests, build, `npm audit --audit-level=high`, the project scan, and gitleaks over the pushed commits | any failure |

`npm run verify` runs the same set on demand. `--no-verify` is not used in this
repository; a hook that gets in the way is fixed, not skipped. A genuine false
positive is marked on its line with a comment containing `not-a-secret` and the
reason.

Recommended repository settings on GitHub (owner's task): secret scanning with
**push protection** on; branch protection on `main` (pull request required,
the CI check required, force pushes and deletions blocked).

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | what is deployed. Changes arrive by pull request from `development` after CI is green. |
| `development` | integration branch for day-to-day work. |
| `feature/…`, `fix/…`, `security/…` | short-lived branches merged into `development` by pull request. |

## Security layers of the running service

From the edge inward. Each layer is documented in the code it lives in.

| Layer | Where | What it does |
| --- | --- | --- |
| Transport | Cloud Run | TLS termination; `TRUST_PROXY_HOPS=1` so the real client IP is read for rate limiting and audit, and a client cannot spoof it. |
| HTTP hardening | `src/plugins/security.ts` | helmet headers (HSTS in production), exact-origin CORS allowlist with credentials, request body cap (256 KB), load shedding with 503 instead of falling over. |
| Abuse controls | `src/plugins/security.ts`, `src/routes/v1/auth.ts` | per-IP rate limits: 300 requests/min globally, 10 per 5 minutes on sign-in, register, refresh and password reset; account lockout after 8 failed sign-ins; password-reset codes limited to 5 attempts and 10 minutes. |
| Input validation | `src/schemas/*.ts` | every route validates params, query and body against a TypeBox schema; unknown fields are dropped; responses are serialized against schemas so nothing extra leaks. |
| Authentication | `src/auth/*` | Argon2id password hashes with a server-side pepper from Secret Manager (a dumped table cannot be cracked offline); HS256 access tokens that live 10 minutes with pinned algorithm, issuer and audience; opaque refresh tokens stored as SHA-256, rotated on every use, with reuse detection that revokes the whole session family; timing-safe handling of unknown accounts; identical errors for unknown account and wrong password; the console keeps its refresh token in an httpOnly cookie. |
| Authorization | `src/auth/guard.ts` | rights are read from the database on every request, never from the token, so revoking a permission or signing out takes effect immediately; role guards per route; moderator permissions per action; the actor of any decision is the token holder, never a body field; "not yours" answers 404, not 403. |
| Data access | `src/db/database.ts`, `migrations/002` | static SQL with `$n` parameters only (the layer rejects template interpolation at runtime); the API connects as a least-privilege role that cannot change a user's role, delete users, or edit the audit tables; migrations run as a separate role at deploy time. |
| Secrets and config | `src/config/env.ts`, `src/config/secrets.ts` | configuration validated at boot; production refuses wildcard or plaintext CORS, unverified database TLS and long-lived tokens; the process never logs configuration values. |
| Audit and logging | `src/logging/*` | append-only security events and login attempts with the actor, role, request id and a keyed IP hash; log redaction of passwords, tokens and cookies; a metadata scrubber that drops secret-like keys before they are stored. |
| Supply chain | `package-lock.json`, CI | pinned lockfile, `npm ci`, `npm audit` at high severity on every push, non-root container user, multi-stage image with dev dependencies pruned. |

## If a secret leaks anyway

1. Rotate it first, ask questions later: create a new Secret Manager version
   and redeploy (`gcloud run deploy …` picks up `:latest`).
2. If the **password pepper** leaked, every stored hash is compromised in
   principle: rotate it and force a password reset for every account.
3. If the **JWT signing key** leaked, rotate it; move the old value to
   `JWT_PREVIOUS_SIGNING_KEY` for one access-token lifetime (10 minutes), then
   remove it.
4. If the **database password** leaked, change it in Neon, update
   `ongo-pg-password`, redeploy.
5. Remove the value from the repository history only if it was a real secret
   (`git filter-repo`, force push, and tell everyone with a clone). Placeholders
   flagged by a scanner are not secrets; mark them resolved and fix the
   placeholder so it stops matching.
6. Record the incident in `security_events` terms: what leaked, when, what was
   rotated, and add a rule here if a rule was missing.
