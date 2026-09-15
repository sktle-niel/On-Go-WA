# On Go Backend — Project Memory

Last updated: 2026-09-15. Keep this file honest: it is what the next session
plans against. Update the **Status** section whenever something is finished.

## What this is

The REST API behind On Go (roadside mechanic services). It serves two Flutter
front ends that another developer builds:

| Front end | Roles | Where it lives |
| --- | --- | --- |
| Mobile app | Client, Mechanic | `../On-Go/lib` |
| Admin console (web) | Admin, Moderator | separate `on_go_console` repository (not on this machine; same `on_go_shared` contract) |

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
  005_verification_requests.sql   name/email/document_names + per-request number + one-pending index
  006_service_requests.sql        location, surcharge, cancel/expiry stamps + one-active-per-client index
  007_quotes.sql                  withdrawn_at, rejected_at, rating snapshot on quotes
  008_accept.sql                  one-active-emergency-per-mechanic partial unique index
  009_job_progress.sql            navigating/en_route/arrived/work_started/service_completed + timestamps
  010_payments_points.sql         agreed amount, server-settled payments, points_ledger; revenue_ledger retired
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
  delivery/*.ts        password-reset code delivery: log driver + smtp (nodemailer); pure email template
  storage/*.ts         Storage interface, disk driver, magic-byte validation, signed/public URL signing
  utils/uploads.ts     multipart file validation (magic bytes, size), used by the upload routes
  schemas/*.ts         TypeBox schemas mirroring on_go_shared DTOs (+ verification, moderators, jobs)
  services/*.ts        auth, points, revenue, verification, moderators, jobs (functions over Queryable)
  routes/health.ts     /health/live, /health/ready
  routes/v1/*.ts       one file per domain (auth, verification, moderators, revenue, appearance,
                       points, events, files, jobs), registered under /api/v1
test/
  helpers/             env, PGlite database, app factory, createUser/signInAs
  unit/                config, tokens, errors
  integration/         migrations, health, auth, points, revenue, stubs, events, verification,
                       moderators, storage, delivery, jobs, quotes, accept, status, payments
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
  six-digit code, per-attempt and per-email limits, delivery via a driver:
  `log` for dev, `smtp` for any provider (Step 8)).
- Account lockout after N failures; timing-safe unknown-account path.
- Points policy: public GET, admin PUT, publishes `points_policy.updated`.
- Revenue: admin GET `/revenue/summary` reads completed payments, bucketed by
  month and urgency in `REVENUE_TIMEZONE`. Mobile POST `/payments` is kept for
  the contract but books nothing since slice 5 (see the jobs bullet).
- Appearance: public GET.
- WebSocket `/api/v1/events`: first-frame auth, audience filtering, heartbeat
  re-checks the session, closes 4401 on sign-out.
- Verification requests (Step 5, migration 005): a mechanic submits (one pending
  per account), the console lists/filters/decides (approve/reject/escalate, each
  gated by its permission; admins hold all), ownership hides other mechanics'
  requests as 404, decisions write `moderator_activity` and `admin_audit_log` and
  publish `verification_request.updated` to the owner and the console.
- Code delivery (Step 8, no migration): password-reset codes go through a
  `CodeDelivery` driver (`src/delivery`) — `log` prints in dev and refuses in
  production; `smtp` sends real email through any provider (nodemailer), with
  the password from Secret Manager. Reset requests are limited per email as
  well as per IP. SMS is a future driver behind the same interface.
- Object storage (Step 7, no migration): a `Storage` abstraction (`src/storage`)
  with a disk driver for dev/tests and a single-instance demo; uploads are
  validated by magic bytes, not the declared type. Mechanics attach documents to
  their pending request (`POST /verification-requests/:id/documents`), each
  served by a short-lived signed URL through `GET /api/v1/files/*`; the Sign In
  background (appearance PUT/DELETE) is stored under a `public/` prefix and
  served without a signature. On Cloud Run the disk is ephemeral — a real
  deployment swaps in a cloud driver (GCS); the interface does not change.
- Moderator directory and audit log (Step 6, no migration): admin creates a
  moderator (role set at INSERT, temp password hashed), lists them with
  `actionsHandled`, replaces permissions (immediate, read from the DB each
  request), updates profile, and removes one (status suspended + sessions
  revoked, so access ends next request). Roster changes write `admin_audit_log`;
  `listAuditLog` reads that one stream, so it already includes Step 5 queue
  decisions. Mutations publish `moderator.updated`. Note: the display `role`
  label is always "Moderator" (no column to persist a custom label).
- Jobs domain (Step 10, in progress — migrations 006–010, not in on_go_shared yet):
  slice 1 booking (`/service-requests`, one active request per client), slice 2
  quotes (`MechanicQuote`, ETA cap, one live quote per mechanic, withdraw/reject),
  slice 3 accept (the atomic claim: client-accept a quote and mechanic-accept an
  emergency, both under a row lock so exactly one wins; one active emergency per
  mechanic), slice 4 the status machine (navigating → en_route → arrived →
  work_started → service_completed, idempotent, gated), slice 5 payment and
  points (the client pays a finished job and it closes; the server settles the
  quote price or an Emergency's agreed amount, the priority fee, optionally paid
  with points, and points for both sides into an append-only `points_ledger`;
  `/points/wallet` and `/points/convert`). Events `service_request.created`/
  `.updated`, `quote.submitted`/`.updated`, `payment.completed`. Remaining
  slices: cancel + expiry sweep, locations, reviews + leaderboard, chat.
- Open-pool fix (2026-09-15): `GET /service-requests?scope=open` answers 403 to
  clients and records `authz.denied`; mechanics and console roles still read it.
  Before, any signed-in client could list every pending request with the other
  client's name, address and coordinates (confirmed with a PGlite probe).
- Security plugins, docs, health routes.
- Scripts: migrate, seed-admin, gen-secrets, export-openapi.
- Dockerfile, docker-compose.yml, .env.example.
- Test suite (19 files, 116 tests) on PGlite.

### Implemented since the last hosting snapshot

Every contract endpoint now returns real data. Verification (Step 5), the
moderator directory (Step 6), and object storage — document upload and the Sign
In background — (Step 7) are all live. Nothing answers `501` anymore.

### Verified (2026-09-11)

- `npm run typecheck` clean (TypeScript 7.0.2).
- `npm test` clean: 116 tests on PGlite 0.5.8 (PostgreSQL 18.3 in WebAssembly),
  re-verified 2026-09-15. Migrations 001–010 apply there unchanged, including
  `CREATE ROLE`, partial unique indexes, `AT TIME ZONE 'Asia/Manila'` and bytea
  parameters.
- Schema files import `Type` from `@fastify/type-provider-typebox`, which
  re-exports the `typebox` v1.3 package the provider is built on. Do not
  add `@sinclair/typebox`; its `Static` types do not resolve through the
  provider.

- `npm run build` clean; the built server boots without a database and
  answers `/health/live` 200, `/health/ready` 503, `/docs/json` (24 paths as
  of Step 7) and the 404 envelope.

### Deployed (2026-09-14, staging)

- Cloud Run service `ongo-api` in asia-southeast1:
  `https://ongo-api-618821603306.asia-southeast1.run.app` (`/docs` on).
  First deploy was revision `ongo-api-00001` (Steps 1–3). Steps 5–8 and the
  security hardening were merged to `main` (`ee68043`, CI green) and deployed
  as revision `ongo-api-00004` on 2026-09-14.
- Neon project `blue-grass-28212582` (AWS ap-southeast-1, branch `production`,
  database `neondb`); migrations 001–**005** applied, first admin seeded.
- Secret Manager: `ongo-jwt-signing-key`, `ongo-password-pepper`,
  `ongo-pg-password`, read by the compute service account.
- Env set on the service: `UPLOAD_DIR=/tmp/uploads` (Cloud Run `/app` is not
  writable by the app user, and `/tmp` is ephemeral), `PUBLIC_BASE_URL` = the
  service URL so document and background links are absolute. `DELIVERY_DRIVER`
  is still `log` (no SMTP configured), so reset codes are logged, not emailed.
- `ongo-migrate` Cloud Run Job image updated to the latest so future migrations
  run in-cluster. `/docs/json` now lists 24 paths.
- Verified live 2026-09-14: `/health/ready` → `database: up`; admin sign-in;
  GET `/moderators`, `/verification-requests`, `/audit-log`, `/platform/appearance`
  all 200; and a full appearance upload round trip (PUT → served bytes match →
  DELETE) confirming storage writes work on Cloud Run.

**Ephemeral storage caveat:** uploaded documents and the background live on the
container's `/tmp`, lost on every revision/restart/scale. Fine for a demo; a
real deployment needs a GCS driver (see `deploy/CLOUD_RUN.md` §9).

### Repository hygiene (2026-09-14)

- `SECURITY.md`; `.githooks/` (pre-commit secret scan, pre-push verify) enabled
  by `npm install`; `.github/workflows/ci.yml`; `.gitleaks.toml`;
  `scripts/check-secrets.mjs`. Local dev credentials moved out of
  `docker-compose.yml` into `.env`; every placeholder that looked like a secret
  replaced. `npm audit`: 0 vulnerabilities.

### Not yet verified

- The Redis code path (no Redis locally).
- README.md is not written (Step 4).

### Known issues (confirmed 2026-09-15, owned by later slices)

- A matched job can neither be cancelled nor expire: `deadline_at` is never
  written and there is no sweep. Until the cancel + expiry slice, a job whose
  mechanic disappears holds the client's one active slot.
- After an accept, `service_request.updated` reaches only the two parties, so
  other mechanics' open pools go stale until they refetch.
- Staging still runs the old `POST /payments`, which books whatever fee is
  reported, until this branch is deployed with migration 010.
- Fixed by slice 5 (2026-09-15): the trusted revenue route, finished jobs that
  never closed, and the Emergency accept record's placeholder price.

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
| GET | /verification-requests | listRequests | admin, moderator | live |
| POST | /verification-requests | submit | mechanic | live |
| GET | /verification-requests/:id | findRequest | bearer (owner or console) | live |
| POST | /verification-requests/:id/decision | decide | admin, moderator + permission | live |
| GET | /moderation/activity | listActivity | admin, moderator | live |
| GET/POST | /moderators | listModerators / createModerator | admin | live |
| DELETE | /moderators/:id | removeModerator | admin | live |
| PUT | /moderators/:id/permissions | updatePermissions | admin | live |
| PATCH | /moderators/:id/profile | updateProfile | admin | live |
| GET | /audit-log | listAuditLog | admin | live |
| POST | /payments | reportCompletedPayment | client, mechanic; books nothing, 204 only for a paid job of theirs | live |
| GET | /revenue/summary | fetchSummary | admin | live |
| GET | /platform/appearance | PlatformAppearanceApi.fetch | public | live |
| PUT/DELETE | /platform/appearance | publishBackground / clearBackground | console + canChangeBackground | live |
| POST | /verification-requests/:id/documents | (addition) attach a document | mechanic (owner), while pending | live |
| GET | /files/* | (addition) serve a stored file | public (`public/`) or a valid signed URL | live |
| GET | /platform/points-policy | PointsPolicyApi.fetch | public | live |
| PUT | /platform/points-policy | PointsPolicyApi.update | admin | live |
| POST | /locations | LocationApi.reportLocation | bearer | not registered (Step 10a) |
| GET | /users/:userId/location | LocationApi.fetchLastKnown | owner, console | not registered (Step 10a) |
| GET | /mechanics/:mechanicId/nearby-jobs | LocationApi.findNearbyJobIds | mechanic (self), console | not registered (Step 10a) |
| POST | /service-requests | (addition) book a request | client | live |
| GET | /service-requests | (addition) list open / mine | bearer; `scope=open` mechanic or console only (client 403) | live |
| GET | /service-requests/:id | (addition) one request | owner / mechanic / console | live |
| POST | /service-requests/:id/cancel | (addition) cancel own pending | client | live |
| POST | /service-requests/:id/quotes | (addition) send a quote | mechanic (approved) | live |
| GET | /service-requests/:id/quotes | (addition) list quotes | owner / mechanic / console | live |
| POST | /service-requests/:id/quotes/withdraw | (addition) withdraw own quote | mechanic | live |
| POST | /service-requests/:id/quotes/:quoteId/reject | (addition) reject a quote | client (owner) | live |
| POST | /service-requests/:id/quotes/:quoteId/accept | (addition) accept a quote | client (owner) | live |
| POST | /service-requests/:id/accept | (addition) accept an emergency | mechanic (approved) | live |
| POST | /service-requests/:id/{navigating,en-route,arrived,start-work,complete-service} | (addition) advance a matched job | assigned mechanic | live |
| PUT | /service-requests/:id/agreed-amount | (addition) set an Emergency's agreed price | assigned mechanic, until paid | live |
| POST | /service-requests/:id/pay | (addition) pay a finished job, which closes it | client (owner) | live |
| GET | /points/wallet | (addition) points balance and entries, mechanic earnings | client, mechanic | live |
| POST | /points/convert | (addition) convert points to balance | mechanic | live |
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
   `src/routes/v1/events.ts`. Event names so far: `points_policy.updated`, `verification_request.updated`, `moderator.updated`, `platform_appearance.updated`, `service_request.created`, `service_request.updated`, `quote.submitted`, `quote.updated`, `payment.completed`.
7. `ModerationDecision.actorName`/`actorId` are accepted and ignored; the
   actor is the token holder.
8. **The jobs domain is moving server-side (Step 10, in progress) and is not in
   `on_go_shared` yet — add it with the front-end dev.** Live so far: booking
   (`ServiceRequest`), quotes (`MechanicQuote`), accept (client-accept + emergency
   first-come), and the status machine. Routes are under `/service-requests` (see
   the Routes table); `?scope=open` is for mechanics and console roles only and
   answers 403 to a client. Wire notes: `urgency` uses the capitalized
   `Normal|Urgent|Emergency`; the surcharge (priority fee 0/50/100) is server-set
   from urgency; ETA is in minutes, capped to the completion window (Emergency
   12h, Urgent 3d, Normal none). Events: `service_request.created`/`.updated`,
   `quote.submitted`/`.updated`, `payment.completed` (admin). Payment and the
   points wallet are live (slice 5). Still to come: cancel/expiry, locations,
   reviews/leaderboard, chat.
9. **`LocationApi` (added to `on_go_shared` upstream on 2026-09-13) is not served
   yet:** `POST /locations`, `GET /users/:userId/location`,
   `GET /mechanics/:mechanicId/nearby-jobs?radiusKm=`. Models `GeoPoint`,
   `LocationUpdate` (`source`, `role`, `availability` travel as Dart enum
   names) and `Place`. Planned as ROADMAP Step 10a. The routes are not
   registered, so they answer 404 today, not 501.
10. **`PlatformRevenueApi.reportCompletedPayment` no longer books revenue**
   (slice 5). The server settles the payment when the client calls
   `POST /service-requests/:id/pay`; `POST /payments` answers 204 only for a
   paid job the caller took part in, and 404 otherwise. The app should call
   `/pay` (with `expectedAmount` and `payFeeWithPoints` as needed) and read
   `amountPaid`, `platformFeeCharged`, `feePaidWithPoints`, `pointsAwarded` and
   `clientPointsAwarded` from the returned request. The points wallet
   (`GET /points/wallet`, `POST /points/convert`) replaces `PointsWalletStore`;
   `PointsEntryKind` travels as the Dart enum names.

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
- **Every commit and push is checked.** `.githooks/pre-commit` runs the secret
  scanner on staged files; `.githooks/pre-push` runs it over all tracked files,
  then typecheck, tests and `npm audit --audit-level=high`; CI repeats them and
  adds gitleaks. `--no-verify` is never used. Details in SECURITY.md.

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
- **Placeholders must not look like secrets.** In `.env.example`, docs and
  tests a value is empty or `<described in angle brackets>`; never `key-…`, a
  random-looking string, or a word like `ongo` in a password field.
  GitGuardian flagged four such placeholders in the initial commit
  (2026-09-14); none was real, all were replaced.

### Branches and checks

- `main` is what is deployed; `development` is the working branch; short-lived
  `feature/…`, `fix/…`, `security/…` branches merge into `development` by pull
  request, and `development` merges into `main` by pull request once CI is
  green.
- Local hooks (`npm install` enables them via `scripts/setup-hooks.mjs`):
  pre-commit secret scan, pre-push verify. CI (`.github/workflows/ci.yml`):
  `npm ci`, typecheck, tests, build, `npm audit --audit-level=high`, the
  project scanner (`scripts/check-secrets.mjs`), gitleaks (`.gitleaks.toml`).
- GitHub settings to keep on (owner): secret scanning with push protection;
  branch protection on `main` requiring a pull request and the CI check.

### Working rules (coding sessions)

- **The repository shows only its owner.** Every commit is authored and
  committed by the owner's git identity (`sktle-niel`). No `Co-Authored-By`,
  session or tool trailers in commit messages or PR descriptions; no
  development-tool or model-vendor names in committed files.
- **Before every commit and push:** read the diff for anything secret-like,
  run `npm run verify`, and let the hooks run. Never `--no-verify`.
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
  only the owner's identity (no co-author or tool trailers). Working branch:
  `development`; `main` is what is deployed.
- The front-end repo `https://github.com/sktle-niel/On-Go.git` is cloned at
  `../On-Go` on branch `master` (synced 2026-09-14; a local-only branch
  `local-snapshot` keeps the pre-sync copy). The admin console moved upstream
  to a separate `on_go_console` repository that is not on this machine.

## Commands

```
npm run dev          # watch mode, reads .env if present
npm run typecheck
npm test             # PGlite, no services needed
npm run build        # dist/src and dist/scripts
npm start            # node dist/src/index.js
npm run migrate      # applies migrations/ to the configured Postgres
npm run seed:admin   # reads SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME from .env
npm run secrets      # prints fresh JWT_SIGNING_KEY and PASSWORD_PEPPER
npm run openapi      # writes openapi/openapi.json
npm run verify       # typecheck + tests + secret scan + npm audit (what the git hooks run)
docker compose up -d # local PostgreSQL
```
