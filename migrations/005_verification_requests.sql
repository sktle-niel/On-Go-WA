-- ONGO :: verification requests (Step 5)
--
-- 001 created account_requests with the columns a decision needs (status,
-- escalated, reviewer). What it did not carry is the applicant detail the
-- mobile app submits and the console shows, because that lived in the app's
-- memory until now:
--
--   * name / email — the applicant's own words on the request, kept on the
--     row so the console reads one record, not a join that can go stale if the
--     account is later edited.
--   * document_names — the labels the mechanic lists at submit time. The files
--     themselves (account_request_documents) arrive in Step 7; until then the
--     request carries the names alone.
--
-- Plus a per-request number and the guarantee of one pending request per user.
--
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

ALTER TABLE account_requests
    ADD COLUMN IF NOT EXISTS name           text   NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS email          text   NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS document_names text[] NOT NULL DEFAULT '{}';

-- Human-facing request number (userNumber in the DTO). A sequence, not a
-- count, so two concurrent submits cannot collide on the same value.
CREATE SEQUENCE IF NOT EXISTS account_request_number_seq;

-- One request may be pending per account at a time. A partial unique index
-- enforces it in the database, so two submits racing each other cannot both
-- create a pending row — the second fails and the API answers 409.
CREATE UNIQUE INDEX IF NOT EXISTS account_requests_one_pending_per_user
    ON account_requests (user_id)
    WHERE status = 'pending';

-- Grants. 002's table grants already cover account_requests; the sequence is
-- new and needs its own. Skipped when the roles do not exist (a database that
-- never ran 002, e.g. PGlite in tests).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_app') THEN
        GRANT USAGE, SELECT ON SEQUENCE account_request_number_seq TO ongo_app;
    END IF;
END
$$;
