-- ONGO :: legacy payment reports — a compatibility window
--
-- Migration 010 retired revenue_ledger when payment moved to the server. The
-- mobile app that is live today predates that: it still settles jobs on the
-- device and reports each payment to POST /payments with its own job id. Until
-- it pays through POST /service-requests/:id/pay, those reports are the only
-- record of the app's revenue, so the ledger takes them again, behind the
-- LEGACY_PAYMENT_REPORTS setting and with checks the old route never had: the
-- client who paid only, the fee its urgency actually carries, a recent paidAt,
-- once per job and a daily cap per client.
--
-- The ledger stays append-only: INSERT comes back, UPDATE and DELETE do not.
--
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_app') THEN
        GRANT INSERT ON revenue_ledger TO ongo_app;
    END IF;
END
$$;

-- The daily cap counts a client's reports over the last day.
CREATE INDEX IF NOT EXISTS revenue_ledger_reporter_time_idx
    ON revenue_ledger (reported_by, created_at DESC);
