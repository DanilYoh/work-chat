BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE domain_events
  DROP CONSTRAINT domain_events_tenant_channel_fkey;

ALTER TABLE domain_events
  ADD CONSTRAINT domain_events_tenant_channel_fkey
  FOREIGN KEY (tenant_id, channel_id)
  REFERENCES channels (tenant_id, id)
  ON DELETE SET NULL (channel_id)
  NOT VALID;

ALTER TABLE domain_events
  VALIDATE CONSTRAINT domain_events_tenant_channel_fkey;

INSERT INTO schema_migrations (id)
VALUES ('003_preserve_event_history')
ON CONFLICT (id) DO NOTHING;

COMMIT;
