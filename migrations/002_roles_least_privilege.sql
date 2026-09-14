-- ONGO :: database roles and least-privilege grants
--
-- The API must NEVER connect as the RDS master user. That account can drop
-- tables, read every row, and create roles -- so an SQL-injection bug or a
-- leaked credential in a service that runs as it is a total compromise
-- instead of a contained one.
--
-- Three roles, three jobs:
--
--   ongo_migrator  owns the schema. Runs DDL during deploys only. Its
--                  credential is not present in the running task.
--   ongo_app       what the API connects as. DML on business tables,
--                  INSERT-only on the append-only audit tables, no DDL,
--                  no ability to grant itself anything.
--   ongo_readonly  SELECT for support/analytics. Never used by the API.
--
-- Passwords are intentionally absent here. Create the login credentials out
-- of band and store them in Secrets Manager with rotation enabled, e.g.:
--
--   ALTER ROLE ongo_app WITH LOGIN PASSWORD :'app_password';
--
-- Better still on AWS: skip passwords entirely and use IAM database
-- authentication --
--   GRANT rds_iam TO ongo_app;
-- so the task assumes its role and requests a 15-minute token instead of
-- holding a long-lived secret at all.
--
-- Run this file as the master/owner user, after 001_init.sql.


-- == Roles ==================================================================
-- NOLOGIN group roles; attach login users to them, or grant LOGIN directly.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_migrator') THEN
        CREATE ROLE ongo_migrator NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_app') THEN
        CREATE ROLE ongo_app NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_readonly') THEN
        CREATE ROLE ongo_readonly NOLOGIN;
    END IF;
END
$$;

-- == Lock down the default ==================================================
-- PUBLIC can create objects in `public` by default on older PostgreSQL, and
-- every role inherits PUBLIC. Remove it so an injected CREATE cannot plant a
-- function that later runs with someone else's privileges.

REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- The database name cannot be an expression in GRANT/REVOKE, so build the
-- statements dynamically rather than hardcoding a name that differs per
-- environment (ongo_dev / ongo_staging / ongo_prod).
DO $$
DECLARE
    db text := quote_ident(current_database());
BEGIN
    EXECUTE format('REVOKE ALL ON DATABASE %s FROM PUBLIC', db);
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %s TO ongo_app, ongo_readonly, ongo_migrator', db);
END
$$;

GRANT USAGE ON SCHEMA public TO ongo_app, ongo_readonly;
GRANT USAGE, CREATE ON SCHEMA public TO ongo_migrator;

-- == Application role: business tables ======================================

GRANT SELECT, INSERT, UPDATE, DELETE ON
    sessions,
    account_requests,
    account_request_documents,
    service_requests,
    quotes,
    chat_messages,
    reviews,
    review_likes,
    payments,
    moderator_permissions
TO ongo_app;

-- users: no DELETE. Accounts are deactivated (status = 'deleted'), never
-- hard-removed, so an authorization bug cannot destroy an identity and the
-- audit trail keeps its foreign keys.
GRANT SELECT, INSERT ON users TO ongo_app;
GRANT UPDATE (
    email,
    password_hash,
    status,
    first_name,
    last_name,
    phone,
    address,
    photo_url,
    photo_last_changed_at,
    failed_login_count,
    locked_until,
    last_login_at,
    tokens_valid_from,
    password_changed_at,
    updated_at
) ON users TO ongo_app;
-- Note what is NOT in that list: `id`, `role`, `created_at`. The application
-- role is structurally incapable of changing a user's role, so a privilege
-- escalation bug in the API cannot turn a client into an admin. Role changes
-- are a deliberate, separately-privileged operation (see 003).

-- == Application role: append-only tables ===================================
-- INSERT and SELECT only. No UPDATE, no DELETE -- an attacker who reaches the
-- database through the API cannot edit or erase the evidence.

GRANT SELECT, INSERT ON
    security_events,
    login_attempts,
    admin_audit_log,
    moderator_activity
TO ongo_app;

GRANT USAGE, SELECT ON SEQUENCE
    security_events_id_seq,
    login_attempts_id_seq
TO ongo_app;

-- Retention pruning is a scheduled maintenance job that runs as the migrator,
-- not something the request path can trigger.
GRANT DELETE ON login_attempts, security_events TO ongo_migrator;

-- == Read-only role =========================================================

GRANT SELECT ON ALL TABLES IN SCHEMA public TO ongo_readonly;

-- == Defaults for future tables =============================================
-- Without these, a table created by a later migration silently has no grants
-- and the API fails at runtime instead of at deploy time.

ALTER DEFAULT PRIVILEGES FOR ROLE ongo_migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ongo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ongo_migrator IN SCHEMA public
    GRANT SELECT ON TABLES TO ongo_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE ongo_migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO ongo_app;

-- == Force TLS ==============================================================
-- Belt to the client-side braces (PGSSLMODE=verify-full). Requires a matching
-- pg_hba entry; on RDS set the parameter group's rds.force_ssl = 1, which is
-- the enforceable equivalent.


