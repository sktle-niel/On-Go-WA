-- ONGO :: the jobs domain, slice 4 — the service-status machine (Step 10)
--
-- A matched job moves through stages as the mechanic works it. 001 kept the
-- match/deadline/complete stamps; this adds the in-between progress flags the
-- mobile app tracked in memory:
--
--   navigating → en_route → arrived → work_started → service_completed
--
-- Each is a boolean plus the moment it happened. `service_completed` means the
-- work is done and the mechanic is waiting to be paid; the request stays
-- 'matched' until payment closes it (slice 5). Payment's own flag arrives with
-- that slice.
--
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

ALTER TABLE service_requests
    ADD COLUMN IF NOT EXISTS navigating          boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS navigating_at       timestamptz,
    ADD COLUMN IF NOT EXISTS en_route            boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS en_route_at         timestamptz,
    ADD COLUMN IF NOT EXISTS arrived             boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS arrived_at          timestamptz,
    ADD COLUMN IF NOT EXISTS work_started        boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS work_started_at     timestamptz,
    ADD COLUMN IF NOT EXISTS service_completed   boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS service_completed_at timestamptz;
