# On Go Backend — Roadmap

Ten steps, in order. Each has a goal, the tasks, the definition of done, and
the model that fits. Tick the boxes as they land and update PROJECT.md.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

**Order from here (planned 2026-09-15).** Details are in the steps below and
in PROJECT.md → Known issues.

1. Release Step 10 as it stands: open the pull request into `development`,
   merge to `main`, deploy with one instance and run migrations 006–013
   (deploy/CLOUD_RUN.md §10). Configure SMTP (§11).
2. Hand the jobs contract to the front-end dev: add jobs, wallet, reviews and
   locations to `on_go_shared`, refresh the integration guide, and move the app
   to `/pay` so `LEGACY_PAYMENT_REPORTS` can close.
3. Step 10 slice 8, chat, on the `chat_messages` table from 001, with images
   and unread markers.
4. Storage that survives a restart (a GCS driver, Step 7), then job photos and
   the profile photo on top of it.
5. Account profile routes: name, phone, address and photo.
6. Operations (Step 9): Redis before a second instance, per-account rate
   limits, the retention job, running as `ongo_app`, alerts.
7. Smaller follow-ups: tell other mechanics when a job leaves the pool, review
   paging and console removal, a live location event, the late-arrival notice,
   the stale slice-1 comments in the jobs code, the Fastify deprecation of
   `disableRequestLogging` (FSTDEP023, moves to `logController`), the README
   (Step 4).

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
- [x] `npm run openapi` writes `openapi/openapi.json` (last run 2026-09-15:
      50 paths, handed over with the jobs notes).
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

**Result (2026-09-14).** Service URL
`https://ongo-api-618821603306.asia-southeast1.run.app`, revision
`ongo-api-00001`. `/health/ready` reports `database: up`; the seeded admin
signs in from `/docs` (console surface, refresh cookie set) and authenticates
on the event socket. Job `ongo-migrate` was created from the deployed image
and executed once. Migration 002 changed on the way: `ALTER DEFAULT
PRIVILEGES IN SCHEMA public` without `FOR ROLE`, because the Neon owner is
not a superuser.

**Model.** Mid-tier model for wiring; top-tier model if grants need changing.

---

## Step 4 — README for the front-end developer `[~]` (integration guide written 2026-09-14 outside the repo, now behind Step 10; quick-start README pending)

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
- [ ] Bring `../On Go Documentation/API-Integration-Guide.md` and its docx up
      to date with Step 10 and 10a: jobs, pay, wallet, reviews, locations, the
      compatibility window and the new events.

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

## Step 7 — Object storage `[~]` (disk driver done 2026-09-14; cloud driver pending)

**Goal.** Files (credential documents, the Sign In background) have a home.

**Tasks.**
- [x] `storage/` abstraction: `put`, `delete`, `signedUrl`, with a local-disk
      implementation for dev, tests and a single-instance demo.
- [ ] A cloud implementation for deployment. Planned as S3; on Cloud Run a
      Google Cloud Storage driver fits better, because the service account
      reaches a private bucket without keys. `STORAGE_DRIVER` accepts only
      `disk` today.
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

## Step 9 — CI and deployment `[~]`

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
- [ ] Retention job for `login_attempts`, `security_events` and spent
      `password_reset_codes`.
- [ ] Redis (`REDIS_URL`) before running more than one instance, so events
      and rate-limit counters are shared; one instance until then.
- [ ] Count signed-in traffic per account, not per IP address, so phones
      behind one carrier address do not share a limit.
- [ ] Run the API as `ongo_app` on Neon (carried over from Step 3).
- [ ] Test the Redis event bus and rate limiter in CI with a Redis service
      container.

**Done when.** A push to `main` deploys to a staging environment with TLS,
and the front-end apps can be pointed at it.

**Model.** Mid-tier model for pipelines; top-tier model to review IAM policies and security
groups.

---

## Step 10a — Locations (`LocationApi`) `[x]` (done 2026-09-15)

**Goal.** The phone reports where it is; the server keeps the latest fix per
user and answers "which open jobs are near this mechanic". Added to
`on_go_shared` upstream on 2026-09-13 (`location_api.dart`, `geo_location.dart`,
`place.dart`).

**Tasks.**
- [x] Migration 012 (planned as 005): `user_locations` (one row per user: point, recorded_at,
      accuracy_m, source, role, availability, updated_at) plus a `place` jsonb
      column on `service_requests` for the job Place. Haversine in SQL is
      enough at service-radius distances; PostGIS only if "near me" lists grow.
- [x] `POST /locations` (bearer): body is `LocationUpdate`; `userId` in the body
      is ignored, the token holder is the subject; `role` must match the
      caller; `availability` accepted for mechanics only. Upsert.
- [x] `GET /users/:userId/location` (bearer): own location, console roles, or
      the counterpart on an active job; otherwise 404.
- [x] `GET /mechanics/:mechanicId/nearby-jobs?radiusKm=` (bearer): the mechanic
      themself or a console role. Implements `isJobWithinServiceRadius`
      exactly: radius > 0, valid points, availability `available` (or unset),
      distance <= radius, edge counts as in; returns pending job ids.
- [x] Enum wire values are the Dart enum **names**: `gps | lastKnown | manual`,
      `client | mechanic`, `available | onJob | offline`.
- [x] Integration tests on PGlite, including the radius edge and the
      availability skip.
- [ ] Update the integration guide and regenerate the docx.

**Done when.** A mechanic phone reports a fix and the nearby-jobs query returns
the pending requests inside its radius. Depends on jobs having locations, so
it lands with or right after the first slice of Step 10.

**Result (2026-09-15).** Migration 012 adds `user_locations` (one row per user,
replaced by each report) and `ongo_great_circle_m`, the haversine of
`GeoPoint.distanceTo` in the same order of operations. The three routes follow
the tasks above: `fetchLastKnown` answers 404 for anything the caller may not
see, and nearby jobs come back nearest first. No `place` column, because the
app's bookings carry only text and coordinates. Found on the way: the shared
`Nullable` schema listed the value before null, so the validator's type
coercion turned a booking's `latitude: null` into 0. Null is now tried first,
and the migration repairs (0, 0) rows. 7 tests. The integration guide and its
docx are not updated.

**Model.** Mid-tier model; top-tier review for the ownership rules on
`GET /users/:userId/location`.

---

## Step 10 — The jobs domain `[~]` (in progress; slices 1–7 done by 2026-09-15)

**Goal.** Help requests, quotes, ETA, chat, reviews and QR payments move from
the mobile app's memory to the server, so two devices see the same job.

**Tasks.**
- [~] Plan first: read `../On-Go/lib/data/quote_store.dart` and `project.md`'s
      domain-rules table; write the contract additions to `on_go_shared`
      (DTOs, interfaces, routes) with the front-end dev. The server side is
      written down (PROJECT.md → Contract gaps 8–13, `openapi.json`); the Dart
      side is not.
- [x] Decide what stays client-side (countdown rendering) and what the server
      owns (deadlines from `matchedAt`, ETA caps, cancel lock, expiry sweep,
      priority fees, points awards from `points_policy`).
- [~] Implement in slices: requests, quotes, accept, the status machine,
      payments, cancel and expiry, reviews and the leaderboard are done; chat
      is left.
- [x] Location: haversine in SQL (Step 10a); PostGIS only if "near me" lists
      grow.
- [~] Events for every state change. Missing: other mechanics when a job
      leaves the pool on accept, chat messages, and location updates.
- [ ] Deploy to staging (deploy/CLOUD_RUN.md §10) and move the app onto the
      jobs routes.
- [ ] Slice 8, chat: `chat_messages` (001) already has a body, an image key
      and a reply-to. It needs send and list routes with paging, an event to
      the other party, image upload through storage, and a read marker per
      participant for unread counts (a small migration).

**Done when.** A client on one phone and a mechanic on another complete a job
end to end through the API.

**Compatibility (2026-09-15): the live app's payment reports.** The front end's
`c04792e` connects the app to the API but still settles jobs on the device and
reports each payment to `POST /payments`. Rather than hold the deploy or drop
that revenue, migration 013 and `LEGACY_PAYMENT_REPORTS` let the paying client
book a device job's report again, checked: the urgency's real fee, a `paidAt`
from the last week, once per job, 20 a day, refusals logged. Jobs the server
holds still book only through `/pay`, and the summary reads both without
counting a job twice. Turn the window off once the app pays through `/pay`.
4 tests. Release order and SMTP setup: deploy/CLOUD_RUN.md §10 and §11.

**Slice 7 done (2026-09-15): reviews and leaderboard.** No migration: 001 already
had `reviews` (one per client per mechanic) and `review_likes`. A client creates
or edits their review of a mechanic (`PUT /mechanics/:id/review`, 1 to 5 stars
and a comment) once that mechanic has completed a paid job for them, which the
app never checked; the mechanic hears `review.submitted`. Reviews list newest
first with the average and star distribution (`GET /mechanics/:id/reviews`), any
client or mechanic marks one helpful once (`PUT`/`DELETE /reviews/:id/helpful`),
and `GET /leaderboard` ranks approved, active mechanics by rating or by review
count, with a literal name search and an overall rank. No tier, since the app's
"Gold" had no rule. 5 tests. Remaining: chat.

**Slice 6 done (2026-09-15): cancel and expiry.** Migration 011 backfills
completion deadlines and indexes the expiry sweep. Accepting a quote or an
Emergency stamps `deadline_at` (Emergency 12h, Urgent 3d, Normal none) and
clears old cancel and expiry stamps. The client cancels (`/cancel`, the app's
"Delete") or reopens (`/reopen`, "Revert to Pending") a matched job once the
mechanic's quoted arrival time has passed or they have arrived; a refusal
carries `details.cancellableAt`. The assigned mechanic cancels a Normal or
Urgent job with a reason (`/mechanic-cancel`). An Urgent or Emergency job not
under way by its deadline returns to the pool, stamped with who let it lapse;
the sweep runs before every jobs route and on a background timer
(`JOB_EXPIRY_SWEEP_SECONDS`). Jobs back in the pool are announced to every
mechanic. Stricter than the app, on purpose: no client cancel once work has
started, no mechanic cancel after any progress step (the app checked only
navigating), the cancelling mechanic's quote is withdrawn, an Emergency accept
record is withdrawn on reopen, and the client can no longer accept an
Emergency's accept record. 9 tests.

**Slice 5 done (2026-09-15): payment and points.** Migration 010 adds the
Emergency agreed amount, settlement columns on payments with one completed
payment per request, and an append-only `points_ledger`; `revenue_ledger` is
retired. The client pays a finished job (`POST /service-requests/:id/pay`) and
it closes. In one transaction the server settles the quote price or the agreed
amount, the priority fee from the request (optionally paid with points, and
charged in pesos on a short balance, never waived), and points for both sides
from the policy. Idempotent and race-safe, with `expectedAmount` to refuse a
changed price. The assigned mechanic sets an Emergency's amount
(`PUT .../agreed-amount`), a mechanic converts points to balance
(`POST /points/convert`), and both roles read `GET /points/wallet`. Revenue is
read from payments, and `POST /payments` books nothing. 8 new tests; the
revenue tests were rewritten around server-settled payments.

**Security fix (2026-09-15): the open pool.** `GET /service-requests?scope=open`
answered any signed-in user, so a client could list every other client's
pending request with name, address and coordinates. It now answers 403 to
clients and records `authz.denied`; mechanics and console roles are unchanged.
1 test. Agreed order from here: payments + points → cancel + expiry sweep →
locations (Step 10a) → reviews + leaderboard → chat. Whether unapproved
mechanics should see exact coordinates is an open decision.

**Slice 4 done (2026-09-14): the service-status machine.** Migration 009 adds
the progress flags (navigating, en_route, arrived, work_started,
service_completed) and their timestamps to service_requests. Five mechanic-only
endpoints advance a matched job; each is idempotent (COALESCE keeps the first
timestamp), gated (work needs arrival, service-complete needs work), and locks
the request row so it cannot race a cancel or expiry. service_completed leaves
the request matched — payment closes it. 6 tests.

**Slice 3 done (2026-09-14): accept (the atomic claim).** Migration 008 adds a
partial unique index for one active emergency per mechanic. The client accepts a
live quote (`/quotes/:quoteId/accept`) and a mechanic accepts an emergency
first-come (`/service-requests/:id/accept`); both flip the request to matched
under a `FOR UPDATE` lock with a guarded `WHERE status = pending`, so two accepts
on the same request — proven by parallel-accept tests for both flows — leave
exactly one winner. Emergency accept writes the accept record (a quote,
accepted=true, price 0) and is capped to the 12-hour window. 8 tests.

**Slice 2 done (2026-09-14): quotes.** Migration 007 adds withdrawn_at,
rejected_at and a rating snapshot to quotes. An approved mechanic (verification
approved) sends a quote on a pending Normal/Urgent request: one live quote per
mechanic, the ETA capped to the completion window, a rejected mechanic barred
from re-quoting, a withdrawn quote re-sendable. The client rejects a specific
quote; the mechanic withdraws their own. Events quote.submitted / quote.updated.
7 tests. Emergency stays accept-only (slice 3).

**Slice 1 done (2026-09-14): service requests (booking).** Migration 006 adds
location, surcharge and the cancel/expiry stamps to service_requests, plus a
partial unique index for one active request per client. `jobs.service.ts` and
`/service-requests` routes: book (client), list (`?scope=open` pool for
mechanics, `?scope=mine` own/assigned), read (ownership-gated), cancel (guarded
UPDATE). Concurrency proven by a two-rapid-bookings test. Events
`service_request.created` / `.updated`. 7 tests. Next slices: quotes → accept
(atomic claim) → status machine → chat → payments → reviews → leaderboard.

**Model.** Plan on a top-tier model; implement slices on a mid-tier model; review
money and state-machine code on a top model.
