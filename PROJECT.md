# On Go Backend — Project Memory

Last updated: 2026-09-14. Keep this file honest: it is what the next session
plans against. Update the **Status** section whenever something is finished.

## What this is

The REST API behind On Go (roadside mechanic services). It serves two Flutter
front ends that another developer builds:

| Front end | Roles | Where it lives |
| --- | --- | --- |
| Mobile app | Client, Mechanic | `../On-Go/lib` |
| Admin console (web) | Admin, Moderator | `../On-Go/admin_web` |

The API contract both front ends code against is the pure-Dart package
`../On-Go/packages/on_go_shared` (`lib/src/api/api_endpoints.dart` for routes,
`lib/src/models/` for DTOs). **This backend implements that contract.** Every
route path, JSON field name and enum `wireName` here mirrors it.

**Scope of this repo: backend only.** No Flutter work happens here. Read-only
references into `../On-Go` are fine.

## Decisions (and why)

- **TypeScript + Node 24 + Fastify 5.** The old scaffold in `../On-Go/server`
  was already Fastify/TypeScript and hardened (argon2, jose, zod config,
  least-privilege SQL roles). Fastify is one of the fastest Node frameworks,
  schema-validates every request, and generates OpenAPI from the same schemas.
- **PostgreSQL 16.** The domain is relational and transactional (accounts,
  sessions, payments, audit trails). Three migrations already targeted it.
  Runs anywhere: RDS/Aurora, Neon, Supabase, a container.
- **Redis is optional.** Set `REDIS_URL` when running more than one API
  instance: it shares rate-limit counters and fans out live events. One
  instance works with nothing but Postgres.
- **OpenAPI is the hand-off.** Swagger UI at `/docs`; `npm run openapi` writes
  `openapi/openapi.json`. The front-end developer works from that, not from
  chat.
- **One error envelope.** Every failure is
  `{ "error": { "code", "message", "details"?, "requestId" } }`.
- **Auth design.** Argon2id with a server-side pepper; HS256 access tokens
  that live 10 minutes; opaque refresh tokens stored as SHA-256, rotated on
  every use, with reuse detection that revokes the whole session family. The
  console keeps its refresh token in an httpOnly cookie scoped to
  `/api/v1/auth`; the mobile app gets it in the body. A console role cannot
  sign in from the mobile surface or vice versa (`wrong_surface`).
- **Rights come from the database on every request, never from the token.**
  Revoking a moderator permission or signing out takes effect immediately.
- **Live updates are one WebSocket** (`/api/v1/events`) with first-frame auth,
  so the token never appears in a URL or a proxy log.
- **Tests run on PGlite** (real PostgreSQL compiled to WebAssembly, in
  memory). No Docker needed to run `npm test`; the SQL is exercised unchanged.
- **Trial hosting: Google Cloud Run (Singapore) + Neon free Postgres.**
  Chosen 2026-09-11 for being free under the tiers, supporting WebSockets,
  and building the Dockerfile in Cloud Build (no local Docker). Guide:
  `deploy/CLOUD_RUN.md`. Production later per Step 9 (AWS) or a paid Cloud
  Run/Cloud SQL setup.
- **Staging conveniences are explicit flags**, never defaults:
  `CORS_ALLOW_LOCALHOST=true` admits `http://localhost:*` on a deployed API;
  `DOCS_ENABLED=true` keeps Swagger on. Both off on real production.
- **`PG_CA_CERT` is optional.** With `verify-full`, Node's built-in root
  store verifies providers on a public CA (Neon); private-CA providers (RDS,
  Cloud SQL, Supabase) need the bundle. An untrusted certificate always
  fails the connection.

## Layout

```
migrations/            forward-only SQL, one transaction per file, recorded in schema_migrations
  001_init.sql           users, sessions, login_attempts, security_events, account_requests,
                         documents, audit tables, service_requests, quotes, chat, reviews, payments
  002_roles_least_privilege.sql   ongo_migrator / ongo_app / ongo_readonly roles and grants
  003_audit_actor_role_and_ip.sql actor_role + ip_address on the audit tables
  004_contract_alignment.sql      can_change_background, document kind/label/file_name,
                                  points_policy, platform_appearance, revenue_ledger,
                                  password_reset_codes
scripts/               migrate, seed-admin, gen-secrets, export-openapi
src/
  index.ts             entry: loads remote secrets, then imports bootstrap
  bootstrap.ts         wires config, db, redis, events; listens; graceful shutdown
  app.ts               buildApp(deps): plugins + routes, no listening (tests use inject)
  context.ts           Fastify type augmentation (app.config/db/events/codeDelivery, request.auth)
  config/env.ts        zod-validated configuration; production forbids weak settings
  config/secrets.ts    AWS Secrets Manager → process.env, before config is read
  db/database.ts       Queryable/Database interfaces, pg pool implementation, static-SQL guard
  db/migrate.ts        the migration runner
  auth/password.ts     argon2id + pepper, dummy verify for timing safety, rehash on cost change
  auth/tokens.ts       access token issue/verify (HS256, pinned alg, iss/aud, key rotation)
  auth/sessions.ts     refresh token families: create, rotate, reuse detection, revoke
  auth/users.ts        users table helpers, lockout counter, permissions
  auth/guard.ts        requireAuth({roles}), requirePermission(flag), authenticateAccessToken
  logging/logger.ts    pino with secret redaction
  logging/audit.ts     security_events + login_attempts writers (metadata scrubbed)
  events/bus.ts        EventBus: in-memory or Redis pub/sub; audience filtering
  plugins/security.ts  helmet, cors allowlist, cookie, rate-limit (Redis-aware), under-pressure
  plugins/errors.ts    the error envelope for AppError, validation, 4xx, 500
  plugins/docs.ts      @fastify/swagger + swagger-ui (/docs; off in production unless DOCS_ENABLED)
  schemas/*.ts         TypeBox schemas mirroring on_go_shared DTOs
  services/*.ts        auth, points, revenue business logic (pure functions over Queryable)
  routes/health.ts     /health/live, /health/ready
  routes/v1/*.ts       one file per contract interface, registered under /api/v1
test/
  helpers/             env, PGlite database, app factory, createUser/signInAs
  unit/                config, tokens, errors
  integration/         migrations, health, auth, points, revenue, stubs, events
Dockerfile             multi-stage, non-root, healthcheck; CMD node dist/src/index.js
docker-compose.yml     postgres (default), redis (profile), api (profile full)
.env.example           every setting, with comments
.gcloudignore          what `gcloud run deploy --source .` uploads
deploy/CLOUD_RUN.md    step-by-step trial deployment: Cloud Run + Neon + Secret Manager
```

## Status

### Done (written; see "Not yet verified" below)

- Project scaffold, dependencies installed (Node 24.19, npm 11.17).
- Migrations 001–004 and the runner. 001/002 had their own BEGIN/COMMIT and
  self-registration removed; the runner owns both.
- Configuration, secrets loading, logger with redaction, error taxonomy.
- Database layer with transaction support and PGlite-compatible interface.
- Full auth: sign-in, register (client/mechanic), refresh with rotation and
  reuse detection, sign-out, `/me`, change password (revokes other devices,
  returns a fresh access token), password reset (request + confirm, hashed
  six-digit code, attempt limit, pluggable delivery).
- Account lockout after N failures; timing-safe unknown-account path.
- Points policy: public GET, admin PUT, publishes `points_policy.updated`.
- Revenue: mobile POST `/payments` (idempotent per requestId), admin GET
  `/revenue/summary` bucketed by month and urgency in `REVENUE_TIMEZONE`.
- Appearance: public GET.
- WebSocket `/api/v1/events`: first-frame auth, audience filtering, heartbeat
  re-checks the session, closes 4401 on sign-out.
- Security plugins, docs, health routes.
- Scripts: migrate, seed-admin, gen-secrets, export-openapi.
- Dockerfile, docker-compose.yml, .env.example.
- Test suite (10 files) on PGlite.

### Stubbed — 501 `not_implemented`, full schema and guards in place

- `AccountVerificationApi`: list, submit, get, decide, activity.
- `ModeratorDirectoryApi`: list, create, remove, permissions, profile, audit log.
- `PlatformAppearanceApi`: PUT (multipart upload) and DELETE.

### Verified (2026-09-11)

- `npm run typecheck` clean (TypeScript 7.0.2).
- `npm test` clean: 51 tests in 10 files on PGlite 0.5.8 (PostgreSQL 18.3
  in WebAssembly). All four migrations apply there unchanged, including
  `CREATE ROLE`, `AT TIME ZONE 'Asia/Manila'` and bytea parameters.
- Schema files import `Type` from `@fastify/type-provider-typebox`, which
  re-exports the `typebox` v1.3 package the provider is built on. Do not
  add `@sinclair/typebox`; its `Static` types do not resolve through the
  provider.

- `npm run build` clean; the built server boots without a database and
  answers `/health/live` 200, `/health/ready` 503, `/docs/json` (23 paths)
  and the 404 envelope (smoke-tested 2026-09-11).

### Deployed (2026-09-14, staging)

- Cloud Run service `ongo-api` in asia-southeast1, revision `ongo-api-00001`,
  built by Cloud Build from this folder:
  `https://ongo-api-618821603306.asia-southeast1.run.app` (`/docs` on).
- Neon project `blue-grass-28212582` (AWS ap-southeast-1, branch `production`,
  database `neondb`); migrations 001–004 applied, first admin seeded.
- Secret Manager: `ongo-jwt-signing-key`, `ongo-password-pepper`,
  `ongo-pg-password`, read by the compute service account.
- Cloud Run Job `ongo-migrate` (same image, `node dist/scripts/migrate.js`)
  executed once: nothing new.
- Verified from the laptop: `/health/ready` → `database: up`, `/docs/json`
  23 paths, points-policy and appearance GET, 404 envelope, admin sign-in
  (console surface: cookie set, no refresh token in body), `/me`, WebSocket
  auth → `ready`.

### Not yet verified

- The Redis code path (no Redis locally).
- README.md is not written (Step 4).

## Routes (all under `/api/v1`)

| Method | Path | Contract method | Guard | State |
| --- | --- | --- | --- | --- |
| POST | /auth/sign-in | AuthApi.signIn | public, auth rate limit | live |
| POST | /auth/register | (addition) | public, auth rate limit | live |
| POST | /auth/refresh | (addition) | refresh token body or cookie | live |
| POST | /auth/sign-out | AuthApi.signOut | bearer and/or refresh token | live |
| GET | /auth/me | (addition) | bearer | live |
| POST | /auth/password | AuthApi.changePassword | bearer | live |
| POST | /auth/password/reset | AuthApi.resetPassword (step 1) | public | live |
| POST | /auth/password/reset/confirm | AuthApi.resetPassword (step 2) | public | live |
| GET | /verification-requests | listRequests | admin, moderator | 501 |
| POST | /verification-requests | submit | mechanic | 501 |
| GET | /verification-requests/:id | findRequest | bearer (owner or console) | 501 |
| POST | /verification-requests/:id/decision | decide | admin, moderator + permission | 501 |
| GET | /moderation/activity | listActivity | admin, moderator | 501 |
| GET/POST | /moderators | listModerators / createModerator | admin | 501 |
| DELETE | /moderators/:id | removeModerator | admin | 501 |
| PUT | /moderators/:id/permissions | updatePermissions | admin | 501 |
| PATCH | /moderators/:id/profile | updateProfile | admin | 501 |
| GET | /audit-log | listAuditLog | admin | 501 |
| POST | /payments | reportCompletedPayment | client, mechanic | live |
| GET | /revenue/summary | fetchSummary | admin | live |
| GET | /platform/appearance | PlatformAppearanceApi.fetch | public | live |
| PUT/DELETE | /platform/appearance | publishBackground / clearBackground | console + canChangeBackground | 501 |
| GET | /platform/points-policy | PointsPolicyApi.fetch | public | live |
| PUT | /platform/points-policy | PointsPolicyApi.update | admin | live |
| WS | /events | every `watch*` | first-frame auth | live |
| GET | /health/live, /health/ready | — | public | live |

## Contract gaps to coordinate with the front-end developer

1. `ApiEndpoints.pointsPolicy` in Dart is `/platform/points-policy`; the
   server serves it under `/api/v1/...` like every other route. Add `$_root`.
2. The Dart `AuthApi` has no `register`, `refresh` or `me`; the server does.
3. `resetPassword` is two calls on the server (request a code, confirm with
   the code and the new password).
4. `SignInRequest.identifier` is the account **email**. Usernames such as
   `client` and `demo-mechanic` were local shortcuts and do not exist here.
5. Access tokens expire in 10 minutes; clients must refresh on `token_expired`.
6. `watch*` streams are one WebSocket with the protocol in
   `src/routes/v1/events.ts`. Event names so far: `points_policy.updated`.
7. `ModerationDecision.actorName`/`actorId` are accepted and ignored; the
   actor is the token holder.
8. The jobs domain (help requests, quotes, ETA, chat, reviews, QR payments)
   is not in the contract at all; the mobile app keeps it in memory. Tables
   exist in 001 for when it moves server-side.

## Rules

### Engineering

- **Mirror the contract.** A route, field or enum value that is not in
  `on_go_shared` is either added there too (tell the front-end dev) or listed
  under *Contract gaps* above. Never rename a wire value silently.
- **Static SQL only.** Every runtime value is a `$n` parameter. Dynamic
  identifiers go through `safeIdentifier`. `db/database.ts` rejects template
  interpolation at runtime.
- **Migrations are forward-only**, one file per change, no BEGIN/COMMIT
  inside, grants included (see 004's DO block for the conditional pattern).
- **Grants must work for a non-superuser owner.** Managed Postgres (Neon)
  runs migrations as the database owner, not a superuser: no `FOR ROLE`
  default privileges, nothing that needs `SUPERUSER`. PGlite (superuser)
  proves the SQL, not the privileges; the first run on the real database does.
- **Services are plain functions over `Queryable`** so they run inside or
  outside a transaction and under PGlite in tests.
- **Every route has a TypeBox schema** for params, query, body and each
  response code. That is what makes `/docs` truthful.
- **Errors are `AppError`s** with a code from `utils/errors.ts`. Unknown
  errors become a bare 500; never leak driver text.
- **Tests before "done".** A feature ships with an integration test on
  PGlite. Run `npm run typecheck && npm test`.
- **Cast enum and timestamp parameters** in SQL (`$1::user_role`,
  `$2::timestamptz`) so both pg and PGlite bind them correctly.
- **Never throw inside `withTransaction` after a write that must survive.**
  A throw rolls the transaction back. Return an outcome and throw after
  commit (see `rotateSession`).
- **Access tokens are minted with `issuedAt: tokensValidFromSeconds(user)`**
  so they are never older than the account's `tokens_valid_from` cut-off.
  Any new issuance site must do the same.

### Security

- The actor of any decision is the **token holder**, never a body field.
- **Re-check rights server-side** on every request; the token carries only
  `sub`, `role`, `sid`.
- **Never log or store secrets**: passwords, tokens, codes, peppers. The
  logger redacts and `audit.ts` scrubs, but the rule is not to hand them over.
- Same error for unknown account and wrong password; same 202 for reset
  requests whether or not the email exists.
- Production config refuses wildcard/plaintext CORS, non-verify-full
  database TLS, and access tokens over 15 minutes.
- The API connects as `ongo_app`, never the master user. The migrator runs
  DDL at deploy time only.
- Security-relevant diffs (auth, sessions, guards, SQL grants, crypto) get a
  top-model review before merge.

### Secrets and environment files

Verified 2026-09-11 and to be kept true:

| File | Holds | Ignored by |
| --- | --- | --- |
| `.env.example` | Every setting with placeholder values, comments | nothing — it is the template and is committed |
| `.env` | Local development values (docker-compose Postgres) | git, Docker, gcloud |
| `.env.cloud` | The staging JWT key and pepper (same values as Secret Manager) plus the Neon connection and the `SEED_ADMIN_*` values, for laptop-run migrate/seed only | git, Docker, gcloud |
| Secret Manager | `ongo-jwt-signing-key`, `ongo-password-pepper`, `ongo-pg-password` — what Cloud Run actually reads | — |

- `.gitignore`, `.dockerignore` and `.gcloudignore` all contain `.env`,
  `.env.*` and `!.env.example`. Any new env file name must match `.env.*`.
- On this machine `.env.cloud` is readable only by the user account, SYSTEM
  and Administrators (checked with `icacls`).
- Secret values are never pasted into chat, logs, docs, commit messages or
  tool output. They are generated into shell variables and piped straight
  into Secret Manager / the env file. `deploy/CLOUD_RUN.md` shows
  placeholders only.
- If a value is ever exposed: create a new secret version, redeploy, and
  (for the pepper) force a password reset for every account, because
  rotating the pepper invalidates every stored hash.
- Cloud Run receives secrets through `--set-secrets`, never through
  `--set-env-vars` and never baked into the image.

### Working rules (coding sessions)

- **The repository shows only its owner.** Every commit is authored and
  committed by the owner's git identity (`sktle-niel`). No `Co-Authored-By`,
  session or tool trailers in commit messages or PR descriptions; no
  development-tool or model-vendor names in committed files.
- **No subagents or multi-agent workflows without the user's approval.**
  Work solo with Read/Grep/Bash unless a fan-out is explicitly approved.
- **Save tokens.** Lean replies, one feature per session, `/compact` when the
  context grows. Use a mid-tier model for routine implementation and a small model for
  mechanical edits; use a top-tier model for auth, permissions, SQL grants,
  crypto, and for reviewing security diffs.
- **Ask before installing system software** (Docker, Postgres) or running
  anything outside this folder.
- **Update this file and ROADMAP.md** at the end of every session.
- The user writes in Taglish; replies in Taglish are fine, documents in
  English.

## Environment notes

- Windows 11, Git Bash shell. Long heredocs fail in the Bash tool; use the
  Write tool for files.
- Node 24.19, npm 11.17. npm's allow-scripts skipped argon2/esbuild install
  scripts; both still work (prebuilt binaries).
- No Docker, no `psql`, no local PostgreSQL. Flutter 3.47.1 is installed for
  the front-end repo.
- gcloud CLI 584 is installed but not on PATH in the Bash tool's shell; call
  it as `"/c/Users/user/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"`.
  Never pass an argument containing a space to it from Bash (cmd.exe quoting
  breaks the path); use `--name=on-go-staging`, not `--name="On Go"`.
- Google Cloud: project `ongo-staging-2026` (number 618821603306), region
  asia-southeast1, billing account 01F2AC-2E9C79-B8B63A. Secrets:
  `ongo-jwt-signing-key`, `ongo-password-pepper`, `ongo-pg-password`.
  Cloud Run runs as `618821603306-compute@developer.gserviceaccount.com`.
  Service `ongo-api`: `https://ongo-api-618821603306.asia-southeast1.run.app`.
  Job `ongo-migrate` runs migrations from the deployed image; after a deploy,
  `gcloud run jobs update ongo-migrate --image <new image>` then `execute`.
- Neon: project `blue-grass-28212582`, AWS ap-southeast-1, branch
  `production`, database `neondb`, role `neondb_owner` (owner, not superuser).
  The API connects as the owner for now; the `ongo_app` login is the optional
  hardening left in Step 3.
- `.env.cloud` (git-ignored) holds the staging pepper and key for laptop-run
  migrate/seed; keep it in sync with Secret Manager.
- Git repository since 2026-09-14; remote `origin` is
  `https://github.com/sktle-niel/On-Go-WA.git`, branch `main`. Commits carry
  only the owner's identity (no co-author or tool trailers).

## Commands

```
npm run dev          # watch mode, reads .env if present
npm run typecheck
npm test             # PGlite, no services needed
npm run build        # dist/src and dist/scripts
npm start            # node dist/src/index.js
npm run migrate      # applies migrations/ to the configured Postgres
npm run seed:admin -- --email … --password … --name …
npm run secrets      # prints fresh JWT_SIGNING_KEY and PASSWORD_PEPPER
npm run openapi      # writes openapi/openapi.json
docker compose up -d # local PostgreSQL
```
