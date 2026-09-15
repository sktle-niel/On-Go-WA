-- ONGO :: the jobs domain, slice 2 — quotes (Step 10)
--
-- 001 modelled quotes (request, mechanic, price, eta_minutes, accepted, one
-- per mechanic per request). This adds the two ways a quote leaves the table
-- without being accepted, and the rating snapshot the client sees:
--
--   * withdrawn_at — the mechanic took their own offer back. A withdrawn quote
--     is kept as a record but is no longer live, so the mechanic may quote the
--     job again (the unique row is reused).
--   * rejected_at  — the client turned the offer down. Kept too, and it is what
--     stops the same mechanic re-quoting that job.
--   * rating       — the mechanic's rating at the moment they quoted, so the
--     client's list shows a figure even after the mechanic's average moves.
--
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

ALTER TABLE quotes
    ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
    ADD COLUMN IF NOT EXISTS rejected_at  timestamptz,
    ADD COLUMN IF NOT EXISTS rating       numeric(3,2) NOT NULL DEFAULT 0
        CHECK (rating >= 0 AND rating <= 5);
