-- ONGO :: the jobs domain, slice 8 — job chat (Step 10)
--
-- 001 already has chat_messages (body, image key, reply-to). This file makes it
-- fit how a job's conversation works in the mobile app:
--
--   * A conversation belongs to one match. `mechanic_id` records the job's
--     mechanic when a message was sent, so when a job goes back to the pool and
--     another mechanic takes it, they start with an empty chat and never read
--     the earlier one.
--   * `image_s3_key` becomes `image_key`: files go through the storage driver
--     (disk or Cloud Storage), not S3.
--   * `sent_at` takes the clock at the insert rather than the transaction
--     start, so read markers compare against the moment a message landed.
--   * `chat_reads` keeps how far each participant has read, which is what
--     unread counts are measured from.
--
-- No route wrote chat_messages before this file, so no row lacks a mechanic.
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

ALTER TABLE chat_messages RENAME COLUMN image_s3_key TO image_key;

ALTER TABLE chat_messages
    ADD COLUMN mechanic_id uuid REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chat_messages ALTER COLUMN sent_at SET DEFAULT clock_timestamp();

ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_body_length CHECK (body IS NULL OR length(body) <= 2000);

-- A participant's thread: one match's messages, in order.
CREATE INDEX chat_messages_conversation_idx
    ON chat_messages (request_id, mechanic_id, sent_at, id);

CREATE TABLE chat_reads (
    request_id   uuid        NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at timestamptz NOT NULL,
    PRIMARY KEY (request_id, user_id)
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_app') THEN
        GRANT SELECT, INSERT, UPDATE ON chat_reads TO ongo_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_readonly') THEN
        GRANT SELECT ON chat_reads TO ongo_readonly;
    END IF;
END
$$;
