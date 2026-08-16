import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

interface Migration {
  id: string;
  file: URL;
  baselineQuery: string;
}

const migrations: Migration[] = [
  {
    id: '001_initial',
    file: new URL('../../../infra/postgres/migrations/001_initial.sql', import.meta.url),
    baselineQuery: `
      SELECT
        to_regclass('public.organizations') IS NOT NULL
        AND to_regclass('public.worker_receipts') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND policyname = 'tenant_isolation_worker_receipts'
        ) AS complete
    `,
  },
  {
    id: '002_message_interactions',
    file: new URL(
      '../../../infra/postgres/migrations/002_message_interactions.sql',
      import.meta.url,
    ),
    baselineQuery: `
      SELECT
        to_regclass('public.channel_read_states') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'idempotency_keys'
            AND column_name = 'request_hash'
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'domain_events_tenant_channel_fkey'
        ) AS complete
    `,
  },
  {
    id: '003_preserve_event_history',
    file: new URL(
      '../../../infra/postgres/migrations/003_preserve_event_history.sql',
      import.meta.url,
    ),
    baselineQuery: `
      SELECT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
        WHERE table_row.relname = 'domain_events'
          AND constraint_row.conname = 'domain_events_tenant_channel_fkey'
          AND constraint_row.confdeltype = 'n'
          AND constraint_row.confdelsetcols = ARRAY[(
            SELECT attribute.attnum
            FROM pg_attribute attribute
            WHERE attribute.attrelid = table_row.oid
              AND attribute.attname = 'channel_id'
          )]::smallint[]
      ) AS complete
    `,
  },
  {
    id: '004_quarantine_oversized_events',
    file: new URL(
      '../../../infra/postgres/migrations/004_quarantine_oversized_events.sql',
      import.meta.url,
    ),
    baselineQuery: `
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'domain_events'
            AND column_name = 'outbox_quarantined_at'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'domain_events'
            AND column_name = 'outbox_error'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_index index_row
          JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
          JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
          WHERE index_class.relname = 'domain_events_outbox_idx'
            AND index_namespace.nspname = 'public'
            AND pg_get_indexdef(index_row.indexrelid) LIKE '%(tenant_id, cursor)%'
            AND pg_get_expr(index_row.indpred, index_row.indrelid)
              LIKE '%outbox_quarantined_at IS NULL%'
        ) AS complete
    `,
  },
];

try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const defaultLocalUrl = 'postgresql://workchat:workchat@localhost:5432/workchat';
const connectionString = process.env.MIGRATION_DATABASE_URL ?? defaultLocalUrl;

if (!process.env.MIGRATION_DATABASE_URL && process.env.NODE_ENV === 'production') {
  throw new Error('MIGRATION_DATABASE_URL is required in production');
}

const pool = new Pool({ connectionString, max: 1 });
const client = await pool.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`SELECT pg_advisory_lock(hashtext('work-chat:schema-migrations'))`);

  for (const migration of migrations) {
    const recorded = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id = $1) AS exists`,
      [migration.id],
    );
    const baseline = await client.query<{ complete: boolean }>(migration.baselineQuery);

    if (recorded.rows[0]?.exists) {
      if (!baseline.rows[0]?.complete) {
        throw new Error(`Migration ${migration.id} is recorded but its schema is incomplete`);
      }
      continue;
    }

    if (baseline.rows[0]?.complete) {
      await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [migration.id]);
      console.log(`Baselined ${migration.id}`);
      continue;
    }

    await client.query(await readFile(migration.file, 'utf8'));
    const applied = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id = $1) AS exists`,
      [migration.id],
    );
    if (!applied.rows[0]?.exists) {
      throw new Error(`Migration ${migration.id} did not record itself`);
    }
    console.log(`Applied ${migration.id}`);
  }

  console.log('Database schema is up to date');
} finally {
  try {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query(`SELECT pg_advisory_unlock(hashtext('work-chat:schema-migrations'))`);
  } finally {
    client.release();
    await pool.end();
  }
}
