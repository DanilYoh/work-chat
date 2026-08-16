BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE idempotency_keys
  ADD COLUMN request_hash text;

ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_request_hash_format
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE domain_events
  ADD COLUMN channel_id uuid;

UPDATE domain_events
SET channel_id = CASE
  WHEN jsonb_typeof(payload -> 'message') = 'object'
    AND payload -> 'message' ->> 'channelId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (payload -> 'message' ->> 'channelId')::uuid
  WHEN jsonb_typeof(payload -> 'workItem') = 'object'
    AND payload -> 'workItem' ->> 'channelId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (payload -> 'workItem' ->> 'channelId')::uuid
  WHEN jsonb_typeof(payload -> 'readState') = 'object'
    AND payload -> 'readState' ->> 'channelId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (payload -> 'readState' ->> 'channelId')::uuid
  ELSE NULL
END
WHERE channel_id IS NULL;

-- Historical events can outlive a channel in installations that predate the
-- channel foreign key. Keep those events for audit/outbox recovery, but do not
-- attach them to a non-existent channel or expose them through channel sync.
UPDATE domain_events event
SET channel_id = NULL
WHERE event.channel_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM channels channel
    WHERE channel.tenant_id = event.tenant_id
      AND channel.id = event.channel_id
  );

CREATE INDEX domain_events_channel_sync_idx
  ON domain_events (tenant_id, channel_id, cursor);

ALTER TABLE channels
  ADD CONSTRAINT channels_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE messages
  ADD CONSTRAINT messages_tenant_channel_id_key UNIQUE (tenant_id, channel_id, id);

-- Older schemas only constrained thread_root_id by message id. Promote invalid
-- cross-tenant, cross-channel, and nested replies before tightening the key.
UPDATE messages child
SET thread_root_id = NULL
WHERE child.thread_root_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM messages root
    WHERE root.id = child.thread_root_id
      AND root.tenant_id = child.tenant_id
      AND root.channel_id = child.channel_id
      AND root.thread_root_id IS NULL
  );

ALTER TABLE messages
  DROP CONSTRAINT messages_thread_root_id_fkey;

ALTER TABLE messages
  ADD CONSTRAINT messages_thread_root_same_channel_fkey
  FOREIGN KEY (tenant_id, channel_id, thread_root_id)
  REFERENCES messages (tenant_id, channel_id, id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE messages
  VALIDATE CONSTRAINT messages_thread_root_same_channel_fkey;

ALTER TABLE domain_events
  ADD CONSTRAINT domain_events_tenant_channel_fkey
  FOREIGN KEY (tenant_id, channel_id)
  REFERENCES channels (tenant_id, id)
  ON DELETE SET NULL (channel_id)
  NOT VALID;

ALTER TABLE domain_events
  VALIDATE CONSTRAINT domain_events_tenant_channel_fkey;

ALTER TABLE reactions
  ADD CONSTRAINT reactions_emoji_length
  CHECK (char_length(emoji) BETWEEN 1 AND 32)
  NOT VALID;

ALTER TABLE reactions
  VALIDATE CONSTRAINT reactions_emoji_length;

CREATE TABLE channel_read_states (
  tenant_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_id, user_id),
  FOREIGN KEY (tenant_id, channel_id)
    REFERENCES channels (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);

CREATE INDEX channel_read_states_user_idx
  ON channel_read_states (tenant_id, user_id, channel_id);

ALTER TABLE channel_read_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_user_isolation_channel_read_states
  ON channel_read_states
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = current_setting('app.user_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = current_setting('app.user_id', true)::uuid
  );

-- This role is deliberately local-only. Production provisions its runtime role
-- separately and never uses the bootstrap credentials from docker-compose.
DO $local_role$
BEGIN
  IF current_database() = 'workchat'
    AND EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
    )
    AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workchat_app_local')
  THEN
    CREATE ROLE workchat_app_local
      LOGIN PASSWORD 'workchat-app-local'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$local_role$;

DO $local_grants$
BEGIN
  IF current_database() = 'workchat'
    AND EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
    )
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workchat_app_local')
  THEN
    GRANT CONNECT ON DATABASE workchat TO workchat_app_local;
    GRANT USAGE ON SCHEMA public TO workchat_app_local;
    GRANT SELECT ON organizations, users, memberships, spaces, channel_memberships
      TO workchat_app_local;
    GRANT SELECT, UPDATE ON channels TO workchat_app_local;
    GRANT SELECT, INSERT, UPDATE ON messages TO workchat_app_local;
    GRANT SELECT, INSERT ON message_revisions TO workchat_app_local;
    GRANT SELECT, INSERT, DELETE ON reactions TO workchat_app_local;
    GRANT SELECT, INSERT ON work_items TO workchat_app_local;
    GRANT SELECT, INSERT, UPDATE ON domain_events TO workchat_app_local;
    GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO workchat_app_local;
    GRANT INSERT ON audit_events TO workchat_app_local;
    GRANT SELECT, INSERT ON worker_receipts TO workchat_app_local;
    GRANT SELECT, INSERT, UPDATE ON channel_read_states TO workchat_app_local;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO workchat_app_local;
  END IF;
END
$local_grants$;

INSERT INTO schema_migrations (id)
VALUES ('002_message_interactions')
ON CONFLICT (id) DO NOTHING;

COMMIT;
