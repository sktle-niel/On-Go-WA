-- ONGO :: align the schema with packages/on_go_shared
--
-- The Dart contract (models + API interfaces) is what both front ends code
-- against. This migration adds what 001 did not know about yet:
--
--   * a fourth moderator permission (can_change_background)
--   * the kind / label / file name of a credential document
--   * the points policy (one row, edited by admins)
--   * the platform appearance (one row: the Sign In background)
--   * the revenue ledger that PlatformRevenueApi.reportCompletedPayment writes
--   * password reset codes for AuthApi.resetPassword
--
-- No BEGIN/COMMIT here: the migration runner wraps every file in one
-- transaction and records the version itself.

-- == Moderator permissions ===================================================

ALTER TABLE moderator_permissions
    ADD COLUMN IF NOT EXISTS can_change_background boolean NOT NULL DEFAULT false;

-- == Credential documents ===================================================

CREATE TYPE credential_kind AS ENUM ('mechanic_id', 'document', 'certification');

ALTER TABLE account_request_documents
    ADD COLUMN IF NOT EXISTS kind       credential_kind NOT NULL DEFAULT 'document',
    ADD COLUMN IF NOT EXISTS label      text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS file_name  text NOT NULL DEFAULT '';

-- == Points policy ===========================================================
-- Exactly one row. Rates are numeric, never float: they multiply money.

CREATE TABLE points_policy (
    id                 integer PRIMARY KEY CHECK (id = 1),
    client_normal      numeric(8,2) NOT NULL CHECK (client_normal >= 0),
    client_urgent      numeric(8,2) NOT NULL CHECK (client_urgent >= 0),
    client_emergency   numeric(8,2) NOT NULL CHECK (client_emergency >= 0),
    mechanic_per_peso  numeric(8,4) NOT NULL CHECK (mechanic_per_peso >= 0),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    updated_by         uuid REFERENCES users(id) ON DELETE SET NULL
);

-- The same defaults as PointsPolicy.defaults in the Dart package.
INSERT INTO points_policy (id, client_normal, client_urgent, client_emergency, mechanic_per_peso)
VALUES (1, 1, 3, 5, 0.05);

-- == Platform appearance =====================================================
-- Exactly one row. The image bytes live in object storage (S3); this holds
-- the key and the public URL the mobile app paints.

CREATE TABLE platform_appearance (
    id                    integer PRIMARY KEY CHECK (id = 1),
    auth_background_key   text,
    auth_background_url   text,
    auth_background_type  text,
    updated_at            timestamptz,
    updated_by            uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO platform_appearance (id) VALUES (1);

-- == Revenue ledger ==========================================================
-- What the mobile app reports when a client payment completes. Until the job
-- and payment flow itself moves server-side, the request id is an opaque
-- reference from the app, so it is text rather than a foreign key. One row
-- per request: a retried report cannot book a peso twice.

CREATE TABLE revenue_ledger (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_ref   text NOT NULL,
    platform_fee  numeric(12,2) NOT NULL CHECK (platform_fee >= 0),
    urgency       urgency_level NOT NULL DEFAULT 'Normal',
    paid_at       timestamptz NOT NULL,
    reported_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT revenue_ledger_one_per_request UNIQUE (request_ref)
);

CREATE INDEX revenue_ledger_paid_at_idx ON revenue_ledger (paid_at);

-- == Password reset codes ====================================================
-- The code itself is never stored; only a keyed hash of it. Attempts are
-- counted so a six-digit code cannot be brute-forced inside its lifetime.

CREATE TABLE password_reset_codes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash    bytea NOT NULL,
    expires_at   timestamptz NOT NULL,
    attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    consumed_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_codes_user_idx ON password_reset_codes (user_id, created_at DESC);

-- == Grants ==================================================================
-- 002's default privileges only cover objects created BY ongo_migrator. When a
-- migration runs as another owner (local dev, CI) the grants must be explicit.
-- Skipped when the roles do not exist (a database that never ran 002).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_app') THEN
        GRANT SELECT, UPDATE ON points_policy TO ongo_app;
        GRANT SELECT, UPDATE ON platform_appearance TO ongo_app;
        GRANT SELECT, INSERT ON revenue_ledger TO ongo_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_codes TO ongo_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_readonly') THEN
        GRANT SELECT ON points_policy, platform_appearance, revenue_ledger TO ongo_readonly;
    END IF;
END
$$;
