# Deploying to Google Cloud Run (free tier) + Neon Postgres

A trial/staging deployment that costs nothing under the free tiers, in
Singapore, with TLS, secrets in Secret Manager, and Swagger UI on for the
front-end developer. Everything runs from this folder; Docker is not needed
on your machine because Cloud Build builds the Dockerfile.

What you get: `https://ongo-api-xxxxx-as.a.run.app` serving `/docs`,
`/health/ready`, and the API, backed by a Neon database.

## 0. One-time accounts and tools

1. **Google Cloud**: a project with billing enabled. The free tier keeps the
   bill at $0 under the limits in section 8, but Cloud Run requires billing
   to be on. Note the **project id** (for example `ongo-staging-123456`).
2. **gcloud CLI**: install from https://cloud.google.com/sdk/docs/install
   (Windows installer). Then, in Git Bash:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   gcloud config set run/region asia-southeast1
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
     artifactregistry.googleapis.com secretmanager.googleapis.com
   ```
3. **Neon** (free Postgres): https://neon.tech → New project → region
   **AWS ap-southeast-1 (Singapore)**, Postgres 16. On the dashboard open
   *Connection details*, choose the **direct** host (not `-pooler`), and note
   host, database, user and password.

## 1. Run the migrations and seed the admin from your laptop

Create `.env.cloud` in this folder (it is git-ignored) with the Neon values:

```
NODE_ENV=development
LOG_LEVEL=info
JWT_SIGNING_KEY=<the value printed by npm run secrets>
PASSWORD_PEPPER=<the value printed by npm run secrets>
PGHOST=ep-xxxx.ap-southeast-1.aws.neon.tech
PGPORT=5432
PGDATABASE=neondb
PGUSER=neondb_owner
PGPASSWORD=<from the Neon connection details>
PGSSLMODE=verify-full
SEED_ADMIN_EMAIL=<you@example.com>
SEED_ADMIN_PASSWORD=<at least 12 characters>
SEED_ADMIN_NAME=<Display Name>
```

Neon's certificate chains to a public root, so no `PG_CA_CERT` is needed.
Then:

```bash
node --env-file=.env.cloud --import tsx scripts/migrate.ts
node --env-file=.env.cloud --import tsx scripts/seed-admin.ts   # reads SEED_ADMIN_* from .env.cloud
```

The admin password goes through the env file on purpose: a password typed on
the command line lands in the shell history.

Expected: `applied: 001_init, 002_roles_least_privilege, 003_audit_actor_role_and_ip, 004_contract_alignment`
and `created admin admin@yourdomain.com (…)`.

> The `PASSWORD_PEPPER` used to seed the admin must be the SAME value the
> deployed service uses, or that admin's password will not verify. Generate the
> real secrets first (step 2) and put the real pepper in `.env.cloud` before
> seeding — or seed again after deploying.

## 2. Create the secrets

```bash
npm run secrets          # prints JWT_SIGNING_KEY=… and PASSWORD_PEPPER=…
```

Put each value into Secret Manager (no trailing newline — `printf`, not `echo`):

```bash
printf '%s' 'PASTE_JWT_SIGNING_KEY'  | gcloud secrets create ongo-jwt-signing-key --data-file=-
printf '%s' 'PASTE_PASSWORD_PEPPER'  | gcloud secrets create ongo-password-pepper --data-file=-
printf '%s' 'PASTE_NEON_PASSWORD'    | gcloud secrets create ongo-pg-password    --data-file=-
```

Let the Cloud Run service account read them:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')
SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for s in ongo-jwt-signing-key ongo-password-pepper ongo-pg-password; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done
```

## 3. Deploy

From this folder (the first run takes a few minutes: Cloud Build builds the
Dockerfile and pushes the image to Artifact Registry):

```bash
gcloud run deploy ongo-api \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 --memory 512Mi \
  --min-instances 0 --max-instances 2 \
  --concurrency 80 \
  --timeout 3600 \
  --set-env-vars "NODE_ENV=production,LOG_LEVEL=info,TRUST_PROXY_HOPS=1,DOCS_ENABLED=true,CORS_ALLOW_LOCALHOST=true,CORS_ALLOWED_ORIGINS=,PGHOST=ep-xxxx.ap-southeast-1.aws.neon.tech,PGPORT=5432,PGDATABASE=neondb,PGUSER=neondb_owner,PGSSLMODE=verify-full,PG_POOL_MAX=5" \
  --set-secrets "JWT_SIGNING_KEY=ongo-jwt-signing-key:latest,PASSWORD_PEPPER=ongo-password-pepper:latest,PGPASSWORD=ongo-pg-password:latest"
```

Why these settings:

| Setting | Reason |
| --- | --- |
| `--allow-unauthenticated` | The API does its own auth; Cloud Run must let requests through. |
| `--timeout 3600` | WebSocket connections on `/api/v1/events` count as one long request; this is the maximum. Clients reconnect after it. |
| `--min-instances 0` | Free tier. First request after idle takes a few seconds (cold start). |
| `--max-instances 2` | Headroom for the trial. Without `REDIS_URL` each instance keeps its own event subscribers and rate-limit counters, so a phone connected to one instance misses events published on the other. Use `--max-instances 1` once live jobs depend on events (section 10). |
| `TRUST_PROXY_HOPS=1` | Google's front end sits in front; the real client IP is one hop back. |
| `DOCS_ENABLED=true` | Swagger UI at `/docs` for the front-end developer. Turn off on real production. |
| `CORS_ALLOW_LOCALHOST=true` | A local Flutter web build (`http://localhost:port`) can call the API. Add the console's real `https://` origin to `CORS_ALLOWED_ORIGINS` once it is hosted. |
| `PG_POOL_MAX=5` | Neon's free tier has a small connection limit; two instances × 5 stays under it. |

When it finishes it prints the **Service URL**. Verify:

```bash
URL=https://ongo-api-xxxxx-as.a.run.app
curl -s $URL/health/ready          # {"status":"ok","database":"up"}
curl -s $URL/api/v1/platform/points-policy
```

Open `$URL/docs`, expand **POST /api/v1/auth/sign-in**, and sign in with the
seeded admin using `"surface": "console"`. Then **Authorize** with the
`accessToken` and call `GET /api/v1/auth/me`.

## 4. Redeploying

Every code change: run the same `gcloud run deploy …` command (a new
revision, zero downtime). Environment and secrets are kept unless you pass
`--set-env-vars` / `--set-secrets` again. To change one variable only:

```bash
gcloud run services update ongo-api --update-env-vars CORS_ALLOWED_ORIGINS=https://console.yourdomain.com
```

## 5. Migrations for later releases

Once the image exists, run migrations as a Cloud Run Job instead of from a
laptop. Get the image that the last deploy built:

```bash
IMAGE=$(gcloud run services describe ongo-api --format='value(spec.template.spec.containers[0].image)')
gcloud run jobs create ongo-migrate --image "$IMAGE" --region asia-southeast1 \
  --command node --args dist/scripts/migrate.js \
  --set-env-vars "NODE_ENV=production,PGHOST=ep-xxxx.ap-southeast-1.aws.neon.tech,PGDATABASE=neondb,PGUSER=neondb_owner,PGSSLMODE=verify-full,LOG_LEVEL=info,CORS_ALLOW_LOCALHOST=true" \
  --set-secrets "JWT_SIGNING_KEY=ongo-jwt-signing-key:latest,PASSWORD_PEPPER=ongo-password-pepper:latest,PGPASSWORD=ongo-pg-password:latest"
gcloud run jobs execute ongo-migrate --wait
```

Release order: deploy the job with the new image → execute it → deploy the
service. (Update the job's image with `gcloud run jobs update ongo-migrate --image "$IMAGE"`.)

## 6. Logs and errors

```bash
gcloud run services logs read ongo-api --limit 100
```

Logs are JSON; every request carries a `requestId` that also appears in
error responses. Security events (`securityEvent` field) can be turned into
Cloud Logging alerts, e.g. on `auth.token.reuse_detected`.

## 7. The front-end developer needs

- The Service URL and `/docs`.
- For Flutter web running locally: nothing else (localhost is allowed).
- For a hosted console: its `https://` origin added to `CORS_ALLOWED_ORIGINS`.
- The WebSocket URL is `wss://…/api/v1/events` (protocol in
  `src/routes/v1/events.ts`).

## 8. Costs and limits (verify on the pricing pages; tiers change)

- **Cloud Run free tier per month**: 2 million requests, 180 000 vCPU-seconds,
  360 000 GiB-seconds. At 1 vCPU / 512 MiB that is roughly 50 instance-hours.
  An open WebSocket keeps an instance busy the whole time it is open, so do
  not leave test clients connected all day. Beyond the free tier a small
  service costs a few dollars.
- **Neon free tier**: 0.5 GB storage and a monthly compute-hour allowance;
  the database autosuspends after a few idle minutes and wakes on the first
  query (about a second).
- **Cloud Build**: 120 build-minutes per day free. **Artifact Registry**:
  0.5 GB free; delete old images occasionally.
- **Secret Manager**: 6 active secret versions free.

## 9. Before real production (not this trial)

- Turn `DOCS_ENABLED` off, remove `CORS_ALLOW_LOCALHOST`, set exact origins.
- `--min-instances 1` to remove cold starts (about $8/month).
- A custom domain (Cloud Run domain mapping or a load balancer with Cloud
  Armor as the WAF).
- Redis (Memorystore) and `REDIS_URL` once `--max-instances` > 1 matters for
  rate limiting and events.
- Postgres with backups and a private connection (Cloud SQL via the Cloud
  SQL connector, or Neon's paid tier).
- **Object storage.** The `disk` driver writes to the container filesystem,
  which on Cloud Run is EPHEMERAL: uploaded documents and the Sign In
  background are lost on every new revision, restart or scaled instance. It is
  fine to demonstrate the upload flow on a single instance, but before anyone
  relies on it, swap in a cloud driver — Google Cloud Storage is the natural
  fit here (the Cloud Run service account can access a bucket with no extra
  credentials). The `Storage` interface does not change; only `createStorage`
  gains a `gcs` branch, plus a bucket name in the environment. Until then, do
  not tell mechanics their uploaded IDs are safely stored.
- Alerting on readiness failures, 5xx rate and `auth.token.reuse_detected`.
- Connect as `ongo_app` instead of the Neon owner, so the grants in
  migrations 002–013 apply: give the role a login and a password from a new
  secret, then point `PGUSER` and the password secret at it.
- A scheduled retention job for `login_attempts`, `security_events` and spent
  password reset codes (not written yet).
- Rate limits counted per signed-in account as well as per IP address, since
  mobile carriers put many phones behind one address.

## 10. Releasing the jobs domain (migrations 006 to 013)

Staging revision `ongo-api-00004` has migrations up to 005. The jobs branch
adds 006 to 013 and its code reads them, so the schema goes first:

1. Build and deploy the new revision **without traffic**, with the
   compatibility window on while the mobile app still settles jobs on the
   device:
   ```bash
   gcloud run deploy ongo-api --source . --region asia-southeast1 \
     --no-traffic --tag candidate --max-instances 1 \
     --update-env-vars LEGACY_PAYMENT_REPORTS=true
   ```
   One instance, because the client and the mechanic must hear each other's
   job events, and without `REDIS_URL` an event stays on the instance that
   published it. Raise the limit once Redis is configured (section 9).
2. Run the migrations from that revision's image (section 5):
   ```bash
   REV=$(gcloud run revisions list --service ongo-api --region asia-southeast1 --limit 1 --format='value(metadata.name)')
   IMAGE=$(gcloud run revisions describe "$REV" --region asia-southeast1 --format='value(spec.containers[0].image)')
   gcloud run jobs update ongo-migrate --image "$IMAGE" --region asia-southeast1
   gcloud run jobs execute ongo-migrate --region asia-southeast1 --wait
   ```
   Expected: `applied: 006_service_requests, … 013_legacy_payment_reports`.
3. Check the candidate on its tagged URL (`/health/ready`, and `/docs/json`
   listing about 50 paths), then send it traffic:
   ```bash
   gcloud run services update-traffic ongo-api --region asia-southeast1 --to-latest
   ```

Migrations 006 to 013 only add to the schema, so the previous revision still
runs on it: rolling back is
`gcloud run services update-traffic ongo-api --to-revisions ongo-api-00004=100`.

`JOB_EXPIRY_SWEEP_SECONDS` (default 60) needs no setting. With
`--min-instances 0` the background sweep runs only while an instance is up, and
every jobs route sweeps before it answers anyway. Turn
`LEGACY_PAYMENT_REPORTS` off (`--update-env-vars LEGACY_PAYMENT_REPORTS=false`)
once the app pays through `POST /service-requests/:id/pay`.

## 11. Email for password reset codes (SMTP)

Staging runs `DELIVERY_DRIVER=log`: a reset request answers 202, but no code is
sent and the log records that. To deliver real email:

1. Choose a provider and a sender address you control (Resend, Postmark, Amazon
   SES, or a mailbox with an app password), and note its SMTP host, port and
   user.
2. Store the SMTP password in Secret Manager, piped in from a variable rather
   than typed on the command line:
   ```bash
   printf '%s' "$SMTP_PASSWORD" | gcloud secrets create ongo-smtp-password --data-file=-
   gcloud secrets add-iam-policy-binding ongo-smtp-password \
     --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
   ```
3. Switch the driver:
   ```bash
   gcloud run services update ongo-api --region asia-southeast1 \
     --update-env-vars DELIVERY_DRIVER=smtp,SMTP_HOST=<smtp host>,SMTP_PORT=587,SMTP_USER=<smtp user>,SMTP_FROM=<sender address> \
     --update-secrets SMTP_PASSWORD=ongo-smtp-password:latest
   ```
   The service refuses to start while any SMTP_* value is missing, so a typo
   fails the deploy instead of silently sending nothing.
4. Request a reset for an account you own and check its inbox. A send failure
   is logged as `password reset email failed to send` and never shown to the
   caller, whose answer is always 202.
