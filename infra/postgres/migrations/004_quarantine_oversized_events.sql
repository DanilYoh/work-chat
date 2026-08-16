BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE domain_events
  ADD COLUMN IF NOT EXISTS outbox_quarantined_at timestamptz,
  ADD COLUMN IF NOT EXISTS outbox_error text;

DROP INDEX IF EXISTS domain_events_outbox_idx;

CREATE INDEX domain_events_outbox_idx
  ON domain_events (tenant_id, cursor)
  WHERE published_at IS NULL AND outbox_quarantined_at IS NULL;

INSERT INTO schema_migrations (id)
VALUES ('004_quarantine_oversized_events')
ON CONFLICT (id) DO NOTHING;

COMMIT;
