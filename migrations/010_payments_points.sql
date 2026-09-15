-- ONGO :: the jobs domain, slice 5 — payment and points (Step 10)
--
-- A job closes when the client pays for it. Until now a finished job stayed
-- 'matched' for good, and platform revenue was whatever fee the phone
-- reported. From here the server settles the payment from its own records:
--
--   * service_requests.agreed_amount — EMERGENCY ONLY. An emergency skips
--     quoting, so the assigned mechanic records the price agreed in person.
--     Normal and Urgent jobs are always paid their accepted quote's price.
--   * payments (001) becomes the record of a settled job: the mechanic's
--     amount, ONGO's priority fee, whether that fee was paid with points, and
--     the points each side earned. One completed payment per request.
--   * points_ledger — every point anyone holds, as signed entries. A balance
--     is the sum of a user's entries, so it cannot drift from its history.
--     Append-only for the application role.
--   * revenue_ledger (004) is retired: platform revenue is read from payments,
--     so the application role loses its write grants on the old table.
--
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

ALTER TABLE service_requests
    ADD COLUMN IF NOT EXISTS agreed_amount        numeric(12,2) CHECK (agreed_amount > 0),
    ADD COLUMN IF NOT EXISTS agreed_amount_set_at timestamptz;

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS fee_paid_with_points numeric(12,2) CHECK (fee_paid_with_points >= 0),
    ADD COLUMN IF NOT EXISTS client_points        numeric(12,2) NOT NULL DEFAULT 0 CHECK (client_points >= 0),
    ADD COLUMN IF NOT EXISTS mechanic_points      numeric(12,2) NOT NULL DEFAULT 0 CHECK (mechanic_points >= 0);

-- One completed payment per request: the backstop for two pay taps racing.
-- Rows in other states (a future payment gateway's pending/failed) do not count.
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_completed_per_request
    ON payments (request_id)
    WHERE status = 'completed';

-- Wire values are the mobile app's PointsEntryKind names.
CREATE TYPE points_entry_kind AS ENUM (
    'clientJobCompleted',
    'mechanicJobCompleted',
    'clientPaidSurcharge',
    'mechanicConvertedToBalance'
);

CREATE TABLE points_ledger (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    kind        points_entry_kind NOT NULL,
    -- Signed: positive earns, negative spends. Numeric, never float.
    points      numeric(12,2) NOT NULL CHECK (points <> 0),
    -- The peso side of a movement that has one: a conversion, a fee paid.
    pesos       numeric(12,2) CHECK (pesos >= 0),
    note        text NOT NULL DEFAULT '',
    request_id  uuid REFERENCES service_requests(id) ON DELETE SET NULL,
    -- clock_timestamp, not now(): one payment writes several entries in one
    -- transaction, and the history lists them in the order they happened.
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX points_ledger_user_time_idx ON points_ledger (user_id, created_at DESC);

-- A job gives each person each kind of entry at most once, so a retried or
-- racing payment cannot credit or debit twice.
CREATE UNIQUE INDEX points_ledger_once_per_job
    ON points_ledger (request_id, user_id, kind)
    WHERE request_id IS NOT NULL;

-- Grants. 002's default privileges give the application role full DML on new
-- tables; the ledger is append-only, so UPDATE and DELETE are taken back, and
-- nothing writes the retired revenue ledger any more. Skipped when the roles
-- do not exist.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_app') THEN
        GRANT SELECT, INSERT ON points_ledger TO ongo_app;
        REVOKE UPDATE, DELETE, TRUNCATE ON points_ledger FROM ongo_app;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON revenue_ledger FROM ongo_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_readonly') THEN
        GRANT SELECT ON points_ledger TO ongo_readonly;
    END IF;
END
$$;
