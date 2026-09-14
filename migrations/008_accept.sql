-- ONGO :: the jobs domain, slice 3 — accept (Step 10)
--
-- Acceptance itself needs no new columns: it flips status to 'matched', sets
-- mechanic_id, and stamps accepted_at (all from 001). What it needs is the
-- concurrency backstop for the one rule the app enforces on the mechanic side:
-- a mechanic may hold only ONE active emergency at a time.
--
-- A partial unique index makes that true in the database, so two emergencies
-- accepted by the same mechanic at the same instant cannot both land — the
-- second fails and the API answers 409, no matter how the requests interleave.
-- Normal/Urgent jobs are deliberately NOT capped this way: a mechanic may be
-- matched on several of those at once.
--
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

CREATE UNIQUE INDEX IF NOT EXISTS service_requests_one_active_emergency_per_mechanic
    ON service_requests (mechanic_id)
    WHERE urgency = 'Emergency'::urgency_level AND status = 'matched'::request_status;
