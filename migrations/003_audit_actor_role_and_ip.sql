-- Audit trail: who acted, and from where.
--
-- Two changes, both driven by the console's Audit Log:
--
-- 1. The log is now filtered by the role of the account that performed the
--    action (All / Moderators / Admin), so the actor's role has to be stored
--    rather than inferred. Everything already in admin_audit_log is a
--    moderator-roster change, which only an admin can make, so the backfill
--    below is a statement of fact about those rows and not a guess.
--
-- 2. The Activity Detail view shows the address the action came from. It is
--    recorded here in full, unlike security_events.ip_hash, because an admin
--    reading an audit entry has to be able to see it — a hash answers "was it
--    the same address" but never "which address". Existing rows keep NULL and
--    the console shows them as not recorded.
--
-- Both columns are nullable so this migration cannot fail on a populated
-- table, and so a row whose address the server could not attribute is stored
-- honestly as unknown rather than as a placeholder.

ALTER TABLE admin_audit_log
    ADD COLUMN IF NOT EXISTS actor_role user_role,
    ADD COLUMN IF NOT EXISTS ip_address inet;

-- Every pre-existing entry is a roster change, and only an admin can make one.
UPDATE admin_audit_log SET actor_role = 'admin' WHERE actor_role IS NULL;

-- Queue decisions are written to the audit trail too, so the log covers the
-- whole console rather than the roster alone. They carry the deciding
-- moderator's address for the same reason.
ALTER TABLE moderator_activity
    ADD COLUMN IF NOT EXISTS ip_address inet;

-- The Audit Log's role filter reads actor_role over the whole table.
CREATE INDEX IF NOT EXISTS admin_audit_log_actor_role_idx
    ON admin_audit_log (actor_role, created_at DESC);
