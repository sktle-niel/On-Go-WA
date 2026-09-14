# On Go Backend — Roadmap

Ten steps, in order. Each has a goal, the tasks, the definition of done, and
the model that fits. Tick the boxes as they land and update PROJECT.md.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Step 1 — Green typecheck and tests `[x]` (done 2026-09-11)

**Goal.** The code that exists compiles and every test passes on PGlite.

**Tasks.**
- [x] TypeBox mismatch: schemas now import `Type` from
      `@fastify/type-provider-typebox` (re-exports `typebox` v1.3);
      `@sinclair/typebox` removed.
- [x] argon2 v0.45: named imports (`hash`, `verify`, `needsRehash`,
      `HashOptions`) in `src/auth/password.ts`.
- [x] pino logger cast to `FastifyBaseLogger`; plugins register on the base
      instance, routes on `withTypeProvider()`.
- [x] `npm run typecheck` clean.
- [x] `npm test` clean — 51 tests, 10 files. PGlite ran all four migrations
      including `CREATE ROLE`, `AT TIME ZONE 'Asia/Manila'` and bytea params
      unchanged.
- [x] POST `/auth/refresh` and `/auth/sign-out` have no body schema, so the
      console may send `{}` or no body; the cookie carries the token.

**Bugs found by the tests and fixed.**
- `@fastify/under-pressure` needs an error *class* for `customError`.
- Reuse detection revoked the family inside the same transaction that then
  threw, so the revocation rolled back. The transaction now returns an
  outcome and the throw happens after commit.
- Only a token whose `end_reason` is `rotated` counts as reuse; a token dead
  from sign-out or a password change is just invalid (no second critical
  event).
- `tokens_valid_from` vs JWT `iat` (1-second resolution): the cut-off is
  rounded up, and every issued token uses `max(now, ceil(tokens_valid_from))`
  as `iat`, so a token minted in the same second as a password change is
  retired while the replacement stays valid.

**Done when.** Typecheck and all 10 test files pass locally. ✔

**Model.** Mid-tier model. Have a top model glance at any change to auth/sessions.

---

## Step 2 — Build and container `[x]` (done 2026-09-11, Docker image deferred to Cloud Build)

**Goal.** The production artifact runs.

**Tasks.**
- [x] `npm run build` produces `dist/src` and `dist/scripts`.
- [x] `node dist/src/index.js` boots without a database: `/health/live` 200,
      `/health/ready` 503 `degraded`, `/docs/json` lists 23 paths, unknown
      routes return the error envelope.
- [ ] `npm run openapi` writes `openapi/openapi.json` (run when the front-end
      dev needs the file).
- [~] Docker image: no Docker on this machine. Cloud Build builds the same
      Dockerfile during the first `gcloud run deploy` (Step 3).

**Also done for hosting.** `TRUST_PROXY_HOPS` documented for Cloud Run,
`CORS_ALLOW_LOCALHOST` flag for staging, `PG_CA_CERT` optional when the
provider's certificate chains to a public root, `.gcloudignore`, and the
step-by-step guide `deploy/CLOUD_RUN.md`.

**Model.** Mid-tier model.

---

## Step 3 — A real PostgreSQL: Neon + Cloud Run `[x]` (done 2026-09-14; hardening optional)

**Goal.** Migrations and the seed run against actual Postgres, and the API is
reachable at a public URL. Follow `deploy/CLOUD_RUN.md`.

**Tasks (user).**
- [x] Google Cloud project `ongo-staging-2026` (number 618821603306), billing
      linked, gcloud CLI 584 installed and signed in, default region
      asia-southeast1, APIs enabled (run, cloudbuild, artifactregistry,
      secretmanager, compute). Done 2026-09-11.
- [x] Neon free project in AWS ap-southeast-1 (Singapore); note the direct
      connection details.

**Tasks (together).**
- [x] `.env.cloud` scaffolded with the real JWT key and pepper; the four
      `REPLACE-…` PG lines filled from Neon on 2026-09-14.
- [x] `node --env-file=.env.cloud --import tsx scripts/migrate.ts` applies
      001–004 on Neon.
- [x] Seed the first admin the same way.
- [x] Secret Manager: `ongo-jwt-signing-key` and `ongo-password-pepper`
      created and readable by the compute service account;
      `ongo-pg-password` added 2026-09-14 (piped in, never printed).
- [x] Env safety verified 2026-09-11: `.env` / `.env.*` ignored by git,
      Docker and gcloud (`.env.example` excepted); no secret values in any
      committed file; `.env.cloud` ACL limited to the user, SYSTEM and
      Administrators. Rules recorded in PROJECT.md → *Secrets and
      environment files*.
- [x] `gcloud run deploy ongo-api --source . …` (guide section 3).
- [x] `curl /health/ready` → `database: up`; sign in as admin from `/docs`.
- [x] Create the `ongo-migrate` Cloud Run Job for future releases.
- [ ] Optional hardening: run the API as `ongo_app` instead of the Neon owner
      (`ALTER ROLE ongo_app WITH LOGIN PASSWORD …`) and confirm the grants
      from 002/004 cover every live route.

**Done when.** The front-end developer can sign in against the public URL and
read `/docs`.
n**Result (2026-09-14).** Service URL
`https://ongo-api-618821603306.asia-southeast1.run.app`, revision
`ongo-api-00001`. `/health/ready` reports `database: up`; the seeded admin
signs in from `/docs` (console surface, refresh cookie set) and authenticates
on the event socket. Job `ongo-migrate` was created from the deployed image
and executed once. Migration 002 changed on the way: `ALTER DEFAULT
PRIVILEGES IN SCHEMA public` without `FOR ROLE`, because the Neon owner is
not a superuser.

**Model.** Mid-tier model for wiring; top-tier model if grants need changing.

---

## Step 4 — README for the front-end developer `[ ]`

**Goal.** Someone who has never seen this repo can run it and integrate.

**Tasks.**
- [ ] Quick start (clone, `.env`, compose, migrate, seed, dev).
- [ ] Every environment variable, with production notes.
- [ ] Auth flow: sign-in, token lifetimes, refresh rotation, cookie vs body,
      sign-out, password change/reset, `wrong_surface`.
- [ ] The error envelope and the list of error codes.
- [ ] The WebSocket protocol and event names.
- [ ] The *Contract gaps* list from PROJECT.md, phrased as instructions for
      the Dart side.
- [ ] Deployment reference: ECS Fargate or App Runner, RDS, ElastiCache, S3,
      Secrets Manager, ALB + WAF, CloudWatch.

**Done when.** The front-end dev can point the Flutter apps at the API without
asking questions in chat.

**Model.** Mid-tier model.

---

## Step 5 — Verification requests `[x]` (done 2026-09-14)

**Goal.** The mobile → console → mobile round trip: a mechanic files, a
moderator decides, the mobile app sees the verdict live.

**Tasks.**
- [x] `services/verification.service.ts`: submit (one pending request per
      user, generate `user_number`), list with filters, find with ownership
      rule (mechanic sees own; console sees all), decide with permission per
      action (`canApprove`/`canReject`/`canEscalate`; admins bypass), write
      `moderator_activity` and `admin_audit_log`, publish
      `verification_request.updated` to the owner and the console roles.
- [x] Map rows to `AccountVerificationRequest` exactly as the Dart DTO reads
      them (`documentNames`, `documents`, `reviewerName`, `escalated`).
- [x] `listActivity` from `moderator_activity`.
- [x] Integration tests: submit, list filters, ownership 404, each decision,
      permission denial, escalation visible to admin, event delivered.
- [x] Replace the 501 handlers in `routes/v1/verification.ts`.

**Done when.** Tests cover the whole round trip and the routes are live.
Documents themselves arrive in Step 7.

**Model.** Top-tier model (permissions and audit logic).

---

**Result (2026-09-14).** Migration 005 adds `name`, `email`, `document_names`
and a per-request number to `account_requests`, plus a partial unique index for
one pending request per user. `services/verification.service.ts` and the live
routes replace the 501 handlers; 9 integration tests cover submit, the pending
conflict, console-only listing, filters, ownership 404, approve/reject/escalate,
permission denial, the actor-is-the-token-holder rule, and the delivered event.
Documents themselves still wait for Step 7.

## Step 6 — Moderator directory and audit log `[x]` (done 2026-09-14)

**Goal.** Admins manage moderators without touching SQL.

**Tasks.**
- [x] `services/moderators.service.ts`: create (hash temporary password,
      insert user + permissions row, audit `added`), list with
      `actionsHandled` counted from `moderator_activity`, remove (status
      `inactive`, revoke sessions, audit `removed`), update permissions
      (audit `promoted`, publish `moderator.updated` so the console session
      refreshes), update profile.
- [x] `listAuditLog` merging roster changes and queue decisions, newest first,
      with `actorRole` and `ipAddress`.
- [x] Record the caller's IP on audit rows (`ip_address inet`), not a hash.
- [x] Integration tests for each operation and for a removed moderator being
      signed out on their next request.
- [x] Replace the 501 handlers in `routes/v1/moderators.ts`.

**Done when.** The console's Moderators, Add Moderator and Audit Log pages can
run entirely against the API.

**Model.** Top-tier model.

---

**Result (2026-09-14).** No migration needed. `services/moderators.service.ts`
and live routes replace the 501 stubs: create (role set at INSERT, temp password
hashed, permissions row), list with `actionsHandled` from `moderator_activity`,
replace permissions, update profile, and remove (status suspended + sessions
revoked). `listAuditLog` reads `admin_audit_log`, which already holds Step 5
queue decisions, so the log is one merged stream. Mutations publish
`moderator.updated`. 7 integration tests, including a removed moderator locked
out on the next request and the merged audit log. The display role label is
always "Moderator" (no column persists a custom label).

## Step 7 — Object storage `[x]` (done 2026-09-14, disk driver; cloud driver at deploy)

**Goal.** Files (credential documents, the Sign In background) have a home.

**Tasks.**
- [x] `storage/` abstraction: `put`, `delete`, `signedUrl`. Local-disk
      implementation for dev/tests, S3 implementation for deployment
      (`@aws-sdk/client-s3`, presigned GET URLs, bucket private).
- [x] `@fastify/multipart` with size and MIME limits (images and PDF for
      documents; JPEG/PNG/WebP ≤ 5 MB for the background).
- [x] Document upload route attached to a verification request; rows in
      `account_request_documents` with `kind`, `label`, `file_name`, sha256.
- [x] `CredentialDocument.uri` is a time-limited URL.
- [x] Appearance PUT/DELETE: store, update `platform_appearance`, publish
      `platform_appearance.updated`.
- [x] Tests with the local-disk implementation.

**Done when.** A moderator can open an applicant's ID from the queue and the
mobile app paints a background published from the console.

**Model.** Mid-tier model; top-tier model for the upload validation.

---

**Result (2026-09-14).** No migration (001+004 already had the columns).
`src/storage` holds the `Storage` interface, a disk driver, and magic-byte
validation; uploads use `@fastify/multipart`. Documents attach to a pending
request and are served by short-lived signed URLs via `GET /api/v1/files/*`;
the background is stored public and served unsigned. Appearance PUT/DELETE
publish `platform_appearance.updated`. 7 integration tests on an in-memory
store. Deploy note: Cloud Run disk is ephemeral, so real persistence needs a
cloud driver (GCS) — a small follow-up when a bucket is configured.

## Step 8 — Code delivery (email / SMS) `[x]` (done 2026-09-14, email via SMTP)

**Goal.** Password reset codes reach people.

**Tasks.**
- [x] User picks a provider (SES, Resend, Postmark, or an SMS gateway).
- [x] Implement `CodeDelivery` for it; keep the log implementation for dev.
- [x] Provider credentials via Secrets Manager; never in `.env` committed.
- [x] Rate-limit reset requests per email as well as per IP.

**Done when.** A reset code arrives in an inbox from a deployed environment.

**Model.** Mid-tier model.

---

**Result (2026-09-14).** A `CodeDelivery` driver layer (`src/delivery`): `log`
for dev, `smtp` (nodemailer) for any provider — Gmail, Resend, Postmark, SES,
Mailtrap — chosen by the SMTP_* settings, password from Secret Manager. The
email content is a pure, tested template. Reset requests are capped per email
(PASSWORD_RESET_EMAIL_MAX/WINDOW) on top of the per-IP limit. 4 tests. SMS
stays a future driver behind the same interface (needs a gateway choice, e.g.
a PH SMS provider). Config `DELIVERY_DRIVER=smtp` requires the SMTP_* values.

## Step 9 — CI and deployment `[ ]`

**Goal.** Every change is checked, and a tagged build reaches a server.

**Tasks.**
- [x] `git init`, first commit pushed to `github.com/sktle-niel/On-Go-WA` (2026-09-14).
- [x] GitHub Actions (2026-09-14): typecheck, test, build, npm audit, secret
      scan and gitleaks on every push to main/development and every PR. The
      Docker build stays in Cloud Build.
- [ ] Infrastructure as code (Terraform or CDK): VPC, RDS Postgres 16 with
      `rds.force_ssl=1`, ElastiCache Redis, S3 bucket, Secrets Manager
      secrets, ECS Fargate service (or App Runner) behind an ALB with AWS
      WAF, CloudWatch log group and alarms on `auth.token.reuse_detected`,
      5xx rate and readiness failures.
- [ ] Migrations as a deploy step (`node dist/scripts/migrate.js` as the
      migrator role) before the new task set goes live.
- [ ] Retention job for `login_attempts` and `security_events`.

**Done when.** A push to `main` deploys to a staging environment with TLS,
and the front-end apps can be pointed at it.

**Model.** Mid-tier model for pipelines; top-tier model to review IAM policies and security
groups.

---

## Step 10a — Locations (`LocationApi`) `[ ]`

**Goal.** The phone reports where it is; the server keeps the latest fix per
user and answers "which open jobs are near this mechanic". Added to
`on_go_shared` upstream on 2026-09-13 (`location_api.dart`, `geo_location.dart`,
`place.dart`).

**Tasks.**
- [ ] Migration 005: `user_locations` (one row per user: point, recorded_at,
      accuracy_m, source, role, availability, updated_at) plus a `place` jsonb
      column on `service_requests` for the job Place. Haversine in SQL is
      enough at service-radius distances; PostGIS only if "near me" lists grow.
- [ ] `POST /locations` (bearer): body is `LocationUpdate`; `userId` in the body
      is ignored, the token holder is the subject; `role` must match the
      caller; `availability` accepted for mechanics only. Upsert.
- [ ] `GET /users/:userId/location` (bearer): own location, console roles, or
      the counterpart on an active job; otherwise 404.
- [ ] `GET /mechanics/:mechanicId/nearby-jobs?radiusKm=` (bearer): the mechanic
      themself or a console role. Implements `isJobWithinServiceRadius`
      exactly: radius > 0, valid points, availability `available` (or unset),
      distance <= radius, edge counts as in; returns pending job ids.
- [ ] Enum wire values are the Dart enum **names**: `gps | lastKnown | manual`,
      `client | mechanic`, `available | onJob | offline`.
- [ ] Integration tests on PGlite, including the radius edge and the
      availability skip.
- [ ] Update the integration guide and regenerate the docx.

**Done when.** A mechanic phone reports a fix and the nearby-jobs query returns
the pending requests inside its radius. Depends on jobs having locations, so
it lands with or right after the first slice of Step 10.

**Model.** Mid-tier model; top-tier review for the ownership rules on
`GET /users/:userId/location`.

---

## Step 10 — The jobs domain `[ ]`

**Goal.** Help requests, quotes, ETA, chat, reviews and QR payments move from
the mobile app's memory to the server, so two devices see the same job.

**Tasks.**
- [ ] Plan first: read `../On-Go/lib/data/quote_store.dart` (1505 lines) and
      `project.md`'s domain-rules table; write the contract additions to
      `on_go_shared` (DTOs, interfaces, routes) with the front-end dev.
- [ ] Decide what stays client-side (countdown rendering) and what the server
      owns (deadlines from `matchedAt`, ETA caps, cancel lock, expiry sweep,
      priority fees, points awards from `points_policy`).
- [ ] Implement in slices: requests → quotes → acceptance and status machine →
      chat → payments (replace `revenue_ledger` with `payments`) → reviews →
      leaderboard.
- [ ] Location: consider PostGIS for "mechanics near me".
- [ ] Events for every state change.

**Done when.** A client on one phone and a mechanic on another complete a job
end to end through the API.

**Model.** Plan on a top-tier model; implement slices on a mid-tier model; review
money and state-machine code on a top model.
