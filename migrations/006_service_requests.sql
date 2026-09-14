-- ONGO :: the jobs domain, slice 1 — service requests (Step 10)
--
-- 001 already modelled service_requests (client, mechanic, status, urgency,
-- issue, coordinates, the accepted/deadline/completed timestamps). This adds
-- what the mobile app kept in memory for a request BEFORE it is accepted:
--
--   * location    — the human address the client typed (coordinates are the
--                   optional precise fix; this is what people read).
--   * surcharge   — ONGO's priority fee for the urgency (0 / 50 / 100),
--                   platform revenue on top of the mechanic's price, fixed on
--                   the request at creation so a later rate change cannot
--                   rewrite a booked job.
--   * cancel/expiry stamps — why a matched job went back to the pool, so the
--                   client's Jobs screen can explain it (mechanic cancelled,
--                   or the completion clock ran out).
--
-- The quote, acceptance, progress and payment columns arrive with their own
-- slices (migrations 007+), so this file stays about the request itself.
--
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

ALTER TABLE service_requests
    ADD COLUMN IF NOT EXISTS location            text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS surcharge           integer NOT NULL DEFAULT 0 CHECK (surcharge >= 0),
    ADD COLUMN IF NOT EXISTS last_cancel_reason  text,
    ADD COLUMN IF NOT EXISTS last_cancelled_by   text,
    ADD COLUMN IF NOT EXISTS last_cancelled_at   timestamptz,
    ADD COLUMN IF NOT EXISTS expired_at          timestamptz,
    ADD COLUMN IF NOT EXISTS expired_by_mechanic text;

-- One ACTIVE request per client at a time. A partial unique index is the
-- concurrency backstop for booking: two taps, or two devices, racing to create
-- a request cannot both land a pending/matched row — the second fails and the
-- API answers 409. 'cancelled' and 'completed' rows are history and do not
-- count, so a client can always book again once their last job is closed.
CREATE UNIQUE INDEX IF NOT EXISTS service_requests_one_active_per_client
    ON service_requests (client_id)
    WHERE status IN ('pending', 'matched');
