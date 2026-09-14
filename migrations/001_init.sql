-- ONGO :: base schema
--
-- Mirrors the domain the Flutter client already models (client / mechanic /
-- moderator / admin, account approval requests, service requests, quotes,
-- job chat, reviews, payments) and adds the tables the security layer needs
-- (sessions, login attempts, security events, audit log).
--
-- Conventions:
--   * every table has a surrogate uuid PK, so no sequential id is ever
--     exposed to a client -- guessing another user's id is not useful
--   * ON DELETE rules are explicit; nothing cascades into an audit trail
--   * timestamps are timestamptz, always UTC
--
-- Run as the schema owner (migration role), not as the application role.


CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

-- == Identity ===============================================================

CREATE TYPE user_role AS ENUM ('client', 'mechanic', 'moderator', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');

CREATE TABLE users (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email                 text        NOT NULL,
    -- Full Argon2id encoded string: algorithm, parameters and salt live
    -- inside it, so parameters can be raised later without a schema change.
    password_hash         text        NOT NULL,
    role                  user_role   NOT NULL,
    status                user_status NOT NULL DEFAULT 'active',

    first_name            text        NOT NULL DEFAULT '',
    last_name             text        NOT NULL DEFAULT '',
    phone                 text        NOT NULL DEFAULT '',
    address               text        NOT NULL DEFAULT '',

    photo_url             text,
    photo_last_changed_at timestamptz,

    -- Brute-force state. Kept on the row so a lockout survives a restart and
    -- is shared across every API task behind the load balancer.
    failed_login_count    integer     NOT NULL DEFAULT 0,
    locked_until          timestamptz,
    last_login_at         timestamptz,

    -- Bumped on password change / forced logout. Any access token issued
    -- before this instant is rejected even though its signature is valid.
    tokens_valid_from     timestamptz NOT NULL DEFAULT now(),
    password_changed_at   timestamptz NOT NULL DEFAULT now(),

    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_failed_login_sane CHECK (failed_login_count >= 0),
    CONSTRAINT users_email_has_at CHECK (position('@' in email) > 1)
);

-- Case-insensitive uniqueness without depending on the citext extension.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_role_status_idx ON users (role, status);

-- Granular moderator rights, mirroring ModeratorPermissions in the client.
-- Separate table so a role change cannot silently carry stale rights.
CREATE TABLE moderator_permissions (
    user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    can_approve  boolean NOT NULL DEFAULT true,
    can_reject   boolean NOT NULL DEFAULT true,
    can_escalate boolean NOT NULL DEFAULT false,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

-- == Sessions and refresh tokens ============================================
--
-- One row per issued refresh token. Rotation inserts a new row and marks the
-- old one rotated; the chain of rows sharing family_id is one login. If a
-- token that was already rotated is presented again, that is replay of a
-- stolen token and the ENTIRE family is revoked.

CREATE TYPE session_end_reason AS ENUM (
    'logout', 'logout_all', 'rotated', 'expired',
    'reuse_detected', 'password_changed', 'revoked_by_admin'
);

CREATE TABLE sessions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id            uuid NOT NULL,

    -- SHA-256 of the refresh token. The token itself is never stored, so a
    -- database dump does not yield usable credentials.
    refresh_token_hash   bytea NOT NULL,

    -- Weak binding signals. Hashed so the table holds no raw PII.
    user_agent_hash      bytea,
    ip_hash              bytea,

    issued_at            timestamptz NOT NULL DEFAULT now(),
    last_used_at         timestamptz NOT NULL DEFAULT now(),
    -- Idle expiry (extended on each rotation).
    expires_at           timestamptz NOT NULL,
    -- Hard ceiling for the whole family; never extended.
    absolute_expires_at  timestamptz NOT NULL,

    revoked_at           timestamptz,
    end_reason           session_end_reason,
    replaced_by          uuid REFERENCES sessions(id) ON DELETE SET NULL,

    CONSTRAINT sessions_expiry_order CHECK (expires_at <= absolute_expires_at)
);

CREATE UNIQUE INDEX sessions_refresh_hash_key ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions (family_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- == Security telemetry =====================================================

CREATE TABLE login_attempts (
    id            bigserial PRIMARY KEY,
    -- Lowercased email as submitted. Kept to detect spraying across accounts;
    -- purged on the retention schedule described in the ops runbook.
    email         text,
    user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    ip_hash       bytea,
    successful    boolean NOT NULL,
    failure_kind  text,
    attempted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_email_time_idx ON login_attempts (lower(email), attempted_at DESC);
CREATE INDEX login_attempts_ip_time_idx ON login_attempts (ip_hash, attempted_at DESC);

-- Append-only security event stream. No secrets, ever -- see logging/audit.ts.
CREATE TABLE security_events (
    id           bigserial PRIMARY KEY,
    event        text NOT NULL,
    severity     text NOT NULL DEFAULT 'info',
    actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_role   user_role,
    target_type  text,
    target_id    text,
    ip_hash      bytea,
    request_id   text,
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX security_events_event_time_idx ON security_events (event, created_at DESC);
CREATE INDEX security_events_actor_idx ON security_events (actor_id, created_at DESC);

-- == Account approval (moderator queue) =====================================

CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE requested_role AS ENUM ('mechanic', 'business');

CREATE TABLE account_requests (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_number   text NOT NULL UNIQUE,
    role          requested_role NOT NULL,
    status        approval_status NOT NULL DEFAULT 'pending',
    escalated     boolean NOT NULL DEFAULT false,
    reason        text,
    submitted_at  timestamptz NOT NULL DEFAULT now(),
    reviewed_at   timestamptz,
    reviewer_id   uuid REFERENCES users(id) ON DELETE SET NULL,

    -- A decision must record who made it and when.
    CONSTRAINT account_requests_review_complete CHECK (
        status = 'pending' OR (reviewed_at IS NOT NULL AND reviewer_id IS NOT NULL)
    )
);

CREATE INDEX account_requests_status_idx ON account_requests (status, submitted_at DESC);
CREATE INDEX account_requests_user_idx ON account_requests (user_id);

-- Uploaded IDs/documents live in S3 (SSE-KMS, no public access). Only the
-- object key is stored; access is brokered by short-lived presigned URLs
-- issued after an authorization check, never by a durable public link.
CREATE TABLE account_request_documents (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id   uuid NOT NULL REFERENCES account_requests(id) ON DELETE CASCADE,
    s3_key       text NOT NULL,
    content_type text NOT NULL,
    byte_size    bigint NOT NULL CHECK (byte_size > 0),
    sha256       bytea NOT NULL,
    uploaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_request_documents_request_idx ON account_request_documents (request_id);

-- == Admin audit trail (moderator lifecycle) ================================

CREATE TABLE admin_audit_log (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_name     text NOT NULL,
    action         text NOT NULL,
    subject_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    subject_name   text NOT NULL,
    subject_role   text NOT NULL,
    reason         text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_log_time_idx ON admin_audit_log (created_at DESC);

-- Moderator throughput feed shown on the admin side.
CREATE TABLE moderator_activity (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action         text NOT NULL,
    request_id     uuid REFERENCES account_requests(id) ON DELETE SET NULL,
    account_name   text NOT NULL,
    account_role   text NOT NULL,
    moderator_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    moderator_name text NOT NULL,
    reason         text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderator_activity_time_idx ON moderator_activity (created_at DESC);

-- == Service requests, quotes, chat, reviews, payments =======================

CREATE TYPE request_status AS ENUM ('pending', 'matched', 'completed', 'cancelled');
CREATE TYPE urgency_level AS ENUM ('Normal', 'Urgent', 'Emergency');

CREATE TABLE service_requests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mechanic_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    status         request_status NOT NULL DEFAULT 'pending',
    urgency        urgency_level NOT NULL DEFAULT 'Normal',
    issue          text NOT NULL,
    description    text NOT NULL DEFAULT '',
    -- Coordinates are personal data; exposure is restricted to the owning
    -- client and the assigned mechanic in the query layer.
    latitude       double precision,
    longitude      double precision,
    created_at     timestamptz NOT NULL DEFAULT now(),
    accepted_at    timestamptz,
    deadline_at    timestamptz,
    completed_at   timestamptz,

    CONSTRAINT service_requests_matched_has_mechanic CHECK (
        status <> 'matched' OR mechanic_id IS NOT NULL
    )
);

CREATE INDEX service_requests_client_idx ON service_requests (client_id, created_at DESC);
CREATE INDEX service_requests_mechanic_idx ON service_requests (mechanic_id, created_at DESC);
CREATE INDEX service_requests_open_idx ON service_requests (status, urgency, created_at)
    WHERE status = 'pending';

CREATE TABLE quotes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id    uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    mechanic_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Money is numeric, never float.
    price         numeric(12,2) NOT NULL CHECK (price >= 0),
    eta_minutes   integer NOT NULL CHECK (eta_minutes > 0),
    accepted      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),

    -- One quote per mechanic per request; re-quoting updates in place.
    CONSTRAINT quotes_unique_per_mechanic UNIQUE (request_id, mechanic_id)
);

CREATE INDEX quotes_request_idx ON quotes (request_id);

CREATE TYPE chat_sender AS ENUM ('client', 'mechanic');

CREATE TABLE chat_messages (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id   uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    sender_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_role  chat_sender NOT NULL,
    body         text,
    image_s3_key text,
    reply_to_id  uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
    sent_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chat_messages_has_content CHECK (
        (body IS NOT NULL AND length(btrim(body)) > 0) OR image_s3_key IS NOT NULL
    )
);

CREATE INDEX chat_messages_request_idx ON chat_messages (request_id, sent_at);

CREATE TABLE reviews (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id   uuid REFERENCES service_requests(id) ON DELETE SET NULL,
    client_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mechanic_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating       smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment      text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    -- Mirrors the client's "one review per client per mechanic" rule.
    CONSTRAINT reviews_one_per_pair UNIQUE (client_id, mechanic_id)
);

CREATE INDEX reviews_mechanic_idx ON reviews (mechanic_id, created_at DESC);

CREATE TABLE review_likes (
    review_id  uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (review_id, user_id)
);

CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed', 'refunded');

CREATE TABLE payments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      uuid NOT NULL REFERENCES service_requests(id) ON DELETE RESTRICT,
    client_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    mechanic_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount          numeric(12,2) NOT NULL CHECK (amount >= 0),
    platform_fee    numeric(12,2) NOT NULL DEFAULT 0 CHECK (platform_fee >= 0),
    status          payment_status NOT NULL DEFAULT 'pending',
    -- Idempotency key supplied by the client so a retried payment cannot be
    -- booked twice.
    idempotency_key text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,

    CONSTRAINT payments_idempotency_unique UNIQUE (client_id, idempotency_key)
);

CREATE INDEX payments_completed_idx ON payments (completed_at)
    WHERE status = 'completed';

-- == updated_at maintenance =================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER reviews_set_updated_at
    BEFORE UPDATE ON reviews
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


