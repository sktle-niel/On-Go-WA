-- ONGO :: the jobs domain, slice 6 — cancel and expiry (Step 10)
--
-- A matched job can now come apart three ways, all taken from the mobile app:
--
--   * the client reverts it to pending or cancels it, once the mechanic's
--     quoted arrival time has run out (or they have arrived) and before work
--     starts;
--   * the assigned mechanic cancels it, with a reason, before setting off;
--   * the completion clock runs out: an Urgent or Emergency job not under way
--     by its deadline goes back to the open pool.
--
-- 001 already has deadline_at and 006 the cancel and expiry stamps, so this
-- file only backfills deadlines for jobs matched before accept started writing
-- them, and indexes what the expiry sweep looks for.
--
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

UPDATE service_requests
   SET deadline_at = accepted_at + CASE urgency
                                     WHEN 'Emergency' THEN interval '12 hours'
                                     ELSE interval '3 days'
                                   END
 WHERE status = 'matched'
   AND deadline_at IS NULL
   AND accepted_at IS NOT NULL
   AND urgency IN ('Emergency', 'Urgent');

-- The sweep reads matched jobs that are not under way yet, by deadline.
CREATE INDEX IF NOT EXISTS service_requests_due_idx
    ON service_requests (deadline_at)
    WHERE status = 'matched' AND work_started = false;
