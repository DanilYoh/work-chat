import { ConfigService } from '@nestjs/config';
import {
  MAX_DOMAIN_EVENT_JSON_BYTES,
  MAX_MESSAGE_REACTION_MEMBERSHIPS,
} from '@work-chat/contracts';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/common/context.js';
import { decodeCursor } from '../src/common/cursor.js';
import { PostgresStore } from '../src/store/postgres.store.js';

const ADMIN_URL = process.env.POSTGRES_INTEGRATION_ADMIN_URL;
const APP_URL = process.env.POSTGRES_INTEGRATION_APP_URL;
const enabled = Boolean(ADMIN_URL && APP_URL);
const runId = randomUUID();

const IDS = {
  tenant: '11111111-1111-4111-8111-111111111111',
  otherTenant: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  owner: '22222222-2222-4222-8222-222222222222',
  member: '22222222-2222-4222-8222-222222222223',
  outsider: '22222222-2222-4222-8222-222222222224',
  backend: '44444444-4444-4444-8444-444444444445',
  incidents: '44444444-4444-4444-8444-444444444446',
  otherChannel: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const;

function context(userId: string, tenantId = IDS.tenant): AppContext {
  return { tenantId, userId, roles: ['owner'], requestId: `postgres-test:${userId}` };
}

function key(scope: string): string {
  return `${scope}:${runId}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(condition: () => Promise<boolean>, timeoutMilliseconds = 3_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for the database state');
}

describe.skipIf(!enabled)('PostgresStore integration', () => {
  let admin: Pool;
  let appPool: Pool;
  let store: PostgresStore;

  beforeAll(async () => {
    if (!ADMIN_URL || !APP_URL) throw new Error('PostgreSQL integration URLs are required');
    admin = new Pool({ connectionString: ADMIN_URL, max: 2 });

    const initialExists = await admin.query<{ exists: boolean }>(
      `SELECT to_regclass('public.organizations') IS NOT NULL AS exists`,
    );
    if (!initialExists.rows[0]?.exists) {
      await admin.query(
        await readFile(
          new URL('../../../infra/postgres/migrations/001_initial.sql', import.meta.url),
          'utf8',
        ),
      );
    }
    const interactionsExist = await admin.query<{ exists: boolean }>(
      `SELECT to_regclass('public.channel_read_states') IS NOT NULL AS exists`,
    );
    if (!interactionsExist.rows[0]?.exists) {
      await admin.query(
        await readFile(
          new URL(
            '../../../infra/postgres/migrations/002_message_interactions.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    }
    for (const migration of ['003_preserve_event_history', '004_quarantine_oversized_events']) {
      const applied = await admin.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id = $1) AS exists`,
        [migration],
      );
      if (!applied.rows[0]?.exists) {
        await admin.query(
          await readFile(
            new URL(`../../../infra/postgres/migrations/${migration}.sql`, import.meta.url),
            'utf8',
          ),
        );
      }
    }
    await admin.query(
      await readFile(new URL('../../../infra/postgres/seed.sql', import.meta.url), 'utf8'),
    );
    await admin.query(
      `
      INSERT INTO users (id, email, display_name)
      VALUES ($1, 'outsider@example.ru', 'Внешний участник')
      ON CONFLICT (id) DO NOTHING
    `,
      [IDS.outsider],
    );
    await admin.query(
      `
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES ($1, $2, 'member')
      ON CONFLICT DO NOTHING
    `,
      [IDS.tenant, IDS.outsider],
    );
    await admin.query(
      `
      INSERT INTO organizations (id, name, slug)
      VALUES ($1, 'Other tenant', 'other-tenant')
      ON CONFLICT (id) DO NOTHING
    `,
      [IDS.otherTenant],
    );
    await admin.query(
      `
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES ($1, $2, 'member')
      ON CONFLICT DO NOTHING
    `,
      [IDS.otherTenant, IDS.owner],
    );
    await admin.query(
      `
      INSERT INTO channels (
        id, tenant_id, name, slug, description, kind, next_sequence
      ) VALUES ($1, $2, 'Other channel', 'other-channel', '', 'public', 0)
      ON CONFLICT (id) DO NOTHING
    `,
      [IDS.otherChannel, IDS.otherTenant],
    );
    await admin.query(
      `
      DELETE FROM channel_read_states
      WHERE tenant_id = $1 AND user_id = $2
    `,
      [IDS.tenant, IDS.outsider],
    );

    store = new PostgresStore(new ConfigService({ DATABASE_URL: APP_URL }));
    appPool = new Pool({ connectionString: APP_URL, max: 2 });
  }, 30_000);

  afterAll(async () => {
    await store?.onModuleDestroy();
    await appPool?.end();
    await admin?.end();
  });

  it('promotes invalid legacy replies before validating the same-channel root constraint', async () => {
    const schema = `migration_${runId.replaceAll('-', '')}`;
    const client = await admin.connect();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const userId = randomUUID();
    const channelA = randomUUID();
    const channelB = randomUUID();
    const channelC = randomUUID();
    const rootId = randomUUID();
    const validReplyId = randomUUID();
    const nestedParentId = randomUUID();
    const nestedReplyId = randomUUID();
    const crossChannelReplyId = randomUUID();
    const crossTenantReplyId = randomUUID();

    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(
        await readFile(
          new URL('../../../infra/postgres/migrations/001_initial.sql', import.meta.url),
          'utf8',
        ),
      );
      await client.query(
        `
        INSERT INTO organizations (id, name, slug)
        VALUES ($1, 'Tenant A', $2), ($3, 'Tenant B', $4)
      `,
        [tenantA, `tenant-a-${runId}`, tenantB, `tenant-b-${runId}`],
      );
      await client.query(
        `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Legacy author')`,
        [userId, `legacy-${runId}@example.com`],
      );
      await client.query(
        `
        INSERT INTO channels (id, tenant_id, name, slug, kind)
        VALUES
          ($1, $2, 'A', 'a', 'public'),
          ($3, $2, 'B', 'b', 'public'),
          ($4, $5, 'C', 'c', 'public')
      `,
        [channelA, tenantA, channelB, channelC, tenantB],
      );
      const insertMessage = async (
        id: string,
        tenantId: string,
        channelId: string,
        sequence: number,
        threadRootId: string | null,
      ) =>
        client.query(
          `
          INSERT INTO messages (
            id, tenant_id, channel_id, thread_root_id, sequence, author_id, blocks
          ) VALUES ($1, $2, $3, $4, $5, $6, '[{"type":"text","text":"legacy"}]')
        `,
          [id, tenantId, channelId, threadRootId, sequence, userId],
        );
      await insertMessage(rootId, tenantA, channelA, 1, null);
      await insertMessage(validReplyId, tenantA, channelA, 2, rootId);
      await insertMessage(nestedParentId, tenantA, channelA, 3, rootId);
      await insertMessage(nestedReplyId, tenantA, channelA, 4, nestedParentId);
      await insertMessage(crossChannelReplyId, tenantA, channelB, 1, rootId);
      await insertMessage(crossTenantReplyId, tenantB, channelC, 1, rootId);

      await client.query(
        await readFile(
          new URL(
            '../../../infra/postgres/migrations/002_message_interactions.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const migrated = await client.query<{ id: string; thread_root_id: string | null }>(
        `
        SELECT id, thread_root_id
        FROM messages
        WHERE id = ANY($1::uuid[])
      `,
        [[validReplyId, nestedParentId, nestedReplyId, crossChannelReplyId, crossTenantReplyId]],
      );
      const roots = new Map(migrated.rows.map((row) => [row.id, row.thread_root_id]));
      expect(roots.get(validReplyId)).toBe(rootId);
      expect(roots.get(nestedParentId)).toBe(rootId);
      expect(roots.get(nestedReplyId)).toBeNull();
      expect(roots.get(crossChannelReplyId)).toBeNull();
      expect(roots.get(crossTenantReplyId)).toBeNull();
    } finally {
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  }, 30_000);

  it('enforces RLS, explicit tenant predicates, and private-channel membership', async () => {
    await expect(
      store.listMessages(context(IDS.outsider), IDS.incidents, null, 50),
    ).rejects.toMatchObject({ status: 403 });

    // The owner belongs to both organizations, so this catches a missing tenant predicate
    // rather than merely relying on user membership to reject the channel.
    await expect(
      store.listMessages(context(IDS.owner), IDS.otherChannel, null, 50),
    ).rejects.toMatchObject({ status: 403 });

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [IDS.tenant]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [IDS.owner]);
      const hidden = await client.query<{ count: string }>(
        `SELECT count(*) FROM channels WHERE tenant_id = $1`,
        [IDS.otherTenant],
      );
      expect(Number(hidden.rows[0]?.count)).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('starts channel history with the newest page and paginates backward', async () => {
    const owner = context(IDS.owner);
    const channelId = randomUUID();
    await admin.query(
      `
      INSERT INTO channels (id, tenant_id, name, slug, description, kind, next_sequence)
      VALUES ($1, $2, 'Pagination regression', $3, '', 'public', 0)
    `,
      [channelId, IDS.tenant, `pagination-${runId}`],
    );

    try {
      const oldest = await store.createMessage(owner, channelId, key('postgres-history-oldest'), {
        clientId: randomUUID(),
        blocks: [{ type: 'text', text: 'Oldest root' }],
      });
      const middle = await store.createMessage(owner, channelId, key('postgres-history-middle'), {
        clientId: randomUUID(),
        blocks: [{ type: 'text', text: 'Middle root' }],
      });
      const newest = await store.createMessage(owner, channelId, key('postgres-history-newest'), {
        clientId: randomUUID(),
        blocks: [{ type: 'text', text: 'Newest root' }],
      });

      const firstPage = await store.listMessages(owner, channelId, null, 2);
      expect(firstPage.items.map((message) => message.id)).toEqual([
        middle.message.id,
        newest.message.id,
      ]);
      const nextCursor = decodeCursor(firstPage.nextCursor ?? undefined);
      expect(nextCursor).toBe(middle.message.sequence);

      const secondPage = await store.listMessages(owner, channelId, nextCursor, 2);
      expect(secondPage.items.map((message) => message.id)).toEqual([oldest.message.id]);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      await admin.query(`DELETE FROM channels WHERE tenant_id = $1 AND id = $2`, [
        IDS.tenant,
        channelId,
      ]);
    }
  });

  it('allocates tenant cursors in commit order', async () => {
    const blocker = await admin.connect();
    let transactionOpen = false;
    let pendingCreate: ReturnType<PostgresStore['createMessage']> | undefined;
    try {
      await blocker.query('BEGIN');
      transactionOpen = true;
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `domain-events:${IDS.tenant}`,
      ]);
      const rawEventId = randomUUID();
      const raw = await blocker.query<{ cursor: string }>(
        `
        INSERT INTO domain_events (
          id, tenant_id, channel_id, audience_user_ids, event_type, payload
        ) VALUES ($1, $2, $3, ARRAY[$4]::uuid[], 'message.created', $5::jsonb)
        RETURNING cursor
      `,
        [
          rawEventId,
          IDS.tenant,
          IDS.backend,
          IDS.owner,
          JSON.stringify({ probe: 'first transaction' }),
        ],
      );
      const rawCursor = Number(raw.rows[0]!.cursor);
      pendingCreate = store.createMessage(
        context(IDS.owner),
        IDS.backend,
        key('postgres-cursor-order'),
        {
          clientId: randomUUID(),
          blocks: [{ type: 'text', text: 'Second transaction' }],
        },
      );

      await waitFor(async () => {
        const waiting = await admin.query<{ exists: boolean }>(
          `
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND wait_event = 'advisory'
              AND query LIKE '%pg_advisory_xact_lock%'
          ) AS exists
        `,
        );
        return waiting.rows[0]?.exists ?? false;
      });

      await blocker.query('COMMIT');
      transactionOpen = false;
      const created = await pendingCreate;
      expect(created.event.cursor).toBeGreaterThan(rawCursor);
      const sync = await store.sync(context(IDS.owner), rawCursor - 1, 100);
      const orderedIds = sync.items.map((event) => event.id);
      expect(orderedIds.indexOf(rawEventId)).toBeGreaterThanOrEqual(0);
      expect(orderedIds.indexOf(created.event.id)).toBeGreaterThan(orderedIds.indexOf(rawEventId));
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK');
      blocker.release();
      await pendingCreate?.catch(() => undefined);
    }
  });

  it('validates roots, returns an absolute thread snapshot, and hashes idempotent requests', async () => {
    const owner = context(IDS.owner);
    const rootClientId = randomUUID();
    const rootKey = key('postgres-thread-root');
    const root = await store.createMessage(owner, IDS.backend, rootKey, {
      clientId: rootClientId,
      blocks: [{ type: 'text', text: 'Thread root' }],
    });

    const replay = await store.createMessage(owner, IDS.backend, rootKey, {
      clientId: rootClientId,
      blocks: [{ type: 'text', text: 'Thread root' }],
    });
    expect(replay.reused).toBe(true);
    expect(replay.message.id).toBe(root.message.id);

    await expect(
      store.createMessage(owner, IDS.backend, rootKey, {
        clientId: randomUUID(),
        blocks: [{ type: 'text', text: 'Different request' }],
      }),
    ).rejects.toMatchObject({ status: 409 });

    const reply = await store.createMessage(owner, IDS.backend, key('postgres-thread-reply'), {
      clientId: randomUUID(),
      threadRootId: root.message.id,
      blocks: [{ type: 'text', text: 'Thread reply' }],
    });
    expect(reply.event.payload.threadRoot).toMatchObject({
      id: root.message.id,
      replyCount: 1,
    });

    const channelMessages = await store.listMessages(owner, IDS.backend, null, 100);
    expect(channelMessages.items.some((message) => message.id === root.message.id)).toBe(true);
    expect(channelMessages.items.some((message) => message.id === reply.message.id)).toBe(false);
    const thread = await store.getThread(owner, root.message.id, 0, 100);
    expect(thread.replies.map((message) => message.id)).toContain(reply.message.id);
    expect(thread.root.replyCount).toBe(1);

    await expect(
      store.createMessage(owner, IDS.incidents, key('postgres-cross-channel-reply'), {
        clientId: randomUUID(),
        threadRootId: root.message.id,
        blocks: [{ type: 'text', text: 'Invalid reply' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('serializes work-item promotion against message deletion', async () => {
    const owner = context(IDS.owner);
    const source = await store.createMessage(owner, IDS.backend, key('postgres-promotion-lock'), {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Promote exactly once before deletion' }],
    });
    const blocker = await admin.connect();
    let transactionOpen = false;
    let promotion: ReturnType<PostgresStore['createWorkItem']> | undefined;
    let deletion: ReturnType<PostgresStore['deleteMessage']> | undefined;
    let deletionSettled = false;
    try {
      await blocker.query('BEGIN');
      transactionOpen = true;
      await blocker.query('LOCK TABLE work_items IN ACCESS EXCLUSIVE MODE');
      promotion = store.createWorkItem(owner, source.message.id, {
        type: 'action',
        title: 'Promotion holding the message lock',
        externalReferences: [],
      });
      await waitFor(async () => {
        const waiting = await admin.query<{ exists: boolean }>(
          `
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE '%INSERT INTO work_items%'
          ) AS exists
        `,
        );
        return waiting.rows[0]?.exists ?? false;
      });

      deletion = store
        .deleteMessage(owner, source.message.id, key('postgres-delete-during-promotion'), {
          expectedRevision: 1,
        })
        .finally(() => {
          deletionSettled = true;
        });
      await delay(100);
      expect(deletionSettled).toBe(false);

      await blocker.query('COMMIT');
      transactionOpen = false;
      const [promoted, deleted] = await Promise.all([promotion, deletion]);
      expect(promoted.item.sourceMessageId).toBe(source.message.id);
      expect(deleted.message.deletedAt).not.toBeNull();
      expect(promoted.event.cursor).toBeLessThan(deleted.event.cursor);
      await expect(
        store.createWorkItem(owner, source.message.id, {
          type: 'action',
          title: 'Too late',
          externalReferences: [],
        }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK');
      blocker.release();
      await promotion?.catch(() => undefined);
      await deletion?.catch(() => undefined);
    }
  });

  it('serializes edits, uses database roles for deletion, and creates terminal tombstones', async () => {
    const author = context(IDS.member);
    const owner = context(IDS.owner);
    const created = await store.createMessage(author, IDS.backend, key('postgres-edit-target'), {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Original' }],
    });

    await expect(
      store.updateMessage(owner, created.message.id, key('postgres-owner-edit'), {
        expectedRevision: 1,
        blocks: [{ type: 'text', text: 'Owner impersonation' }],
      }),
    ).rejects.toMatchObject({ status: 403 });

    const attempts = await Promise.allSettled([
      store.updateMessage(author, created.message.id, key('postgres-concurrent-edit-a'), {
        expectedRevision: 1,
        blocks: [{ type: 'text', text: 'Edit A' }],
      }),
      store.updateMessage(author, created.message.id, key('postgres-concurrent-edit-b'), {
        expectedRevision: 1,
        blocks: [{ type: 'text', text: 'Edit B' }],
      }),
    ]);
    const successes = attempts.filter((result) => result.status === 'fulfilled');
    const failures = attempts.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const updated = (
      successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.updateMessage>>>
    ).value;
    expect(updated.message.revision).toBe(2);

    const firstReaction = await store.setReaction(owner, created.message.id, { emoji: '✅' }, true);
    const duplicateReaction = await store.setReaction(
      owner,
      created.message.id,
      { emoji: '✅' },
      true,
    );
    expect(firstReaction.event?.type).toBe('reaction.added');
    expect(duplicateReaction.event).toBeNull();

    const deleteKey = key('postgres-admin-delete');
    const deleted = await store.deleteMessage(owner, created.message.id, deleteKey, {
      expectedRevision: 2,
    });
    expect(deleted.message).toMatchObject({ revision: 3, blocks: [], reactions: {} });
    expect(deleted.message.deletedAt).not.toBeNull();
    const replay = await store.deleteMessage(owner, created.message.id, deleteKey, {
      expectedRevision: 2,
    });
    expect(replay.reused).toBe(true);
    expect(replay.message).toEqual(deleted.message);

    await expect(
      store.setReaction(owner, created.message.id, { emoji: '👀' }, true),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.updateMessage(author, created.message.id, key('postgres-edit-deleted'), {
        expectedRevision: 3,
        blocks: [{ type: 'text', text: 'Restore' }],
      }),
    ).rejects.toMatchObject({ status: 409 });

    const revisions = await admin.query<{ count: string }>(
      `
      SELECT count(*) FROM message_revisions WHERE message_id = $1
    `,
      [created.message.id],
    );
    expect(Number(revisions.rows[0]?.count)).toBe(2);
  });

  it('redacts deleted message snapshots from sync history and idempotency responses', async () => {
    const owner = context(IDS.owner);
    const createKey = key('postgres-redaction-create');
    const createInput = {
      clientId: randomUUID(),
      blocks: [{ type: 'text' as const, text: 'Original database secret' }],
    };
    const created = await store.createMessage(owner, IDS.backend, createKey, createInput);
    await store.createMessage(owner, IDS.backend, key('postgres-redaction-reply'), {
      clientId: randomUUID(),
      threadRootId: created.message.id,
      blocks: [{ type: 'text', text: 'Reply carrying a root snapshot' }],
    });
    const updateKey = key('postgres-redaction-update');
    const updateInput = {
      expectedRevision: 1,
      blocks: [{ type: 'text' as const, text: 'Edited database secret' }],
    };
    await store.updateMessage(owner, created.message.id, updateKey, updateInput);
    const deleted = await store.deleteMessage(
      owner,
      created.message.id,
      key('postgres-redaction-delete'),
      { expectedRevision: 2 },
    );

    const sync = await store.sync(owner, created.event.cursor - 1, 100);
    const snapshots = sync.items
      .flatMap((event) => [event.payload.message, event.payload.threadRoot])
      .filter(
        (snapshot): snapshot is Record<string, unknown> =>
          typeof snapshot === 'object' && snapshot !== null && snapshot.id === created.message.id,
      );
    expect(snapshots.length).toBeGreaterThanOrEqual(4);
    for (const snapshot of snapshots) {
      expect(snapshot.blocks).toEqual([]);
      expect(snapshot.deletedAt).toEqual(expect.any(String));
    }

    const createReplay = await store.createMessage(owner, IDS.backend, createKey, createInput);
    const updateReplay = await store.updateMessage(
      owner,
      created.message.id,
      updateKey,
      updateInput,
    );
    for (const replay of [createReplay, updateReplay]) {
      expect(replay.reused).toBe(true);
      expect(replay.message).toEqual(deleted.message);
      expect((replay.event.payload.message as { blocks: unknown[] }).blocks).toEqual([]);
    }
  });

  it('caps Postgres reaction memberships without blocking duplicates or removals', async () => {
    const owner = context(IDS.owner);
    const created = await store.createMessage(owner, IDS.backend, key('postgres-reaction-cap'), {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Bound database reactions' }],
    });
    await admin.query(
      `
      INSERT INTO reactions (tenant_id, message_id, user_id, emoji)
      SELECT $1, $2, $3, 'cap-' || value
      FROM generate_series(1, $4::integer) AS value
    `,
      [IDS.tenant, created.message.id, IDS.owner, MAX_MESSAGE_REACTION_MEMBERSHIPS],
    );

    const duplicate = await store.setReaction(owner, created.message.id, { emoji: 'cap-1' }, true);
    expect(duplicate.event).toBeNull();
    await expect(
      store.setReaction(owner, created.message.id, { emoji: 'overflow' }, true),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'REACTION_LIMIT_REACHED' }),
    });
    const removed = await store.setReaction(owner, created.message.id, { emoji: 'cap-1' }, false);
    expect(removed.event?.type).toBe('reaction.removed');
    const replacement = await store.setReaction(
      owner,
      created.message.id,
      { emoji: 'overflow' },
      true,
    );
    expect(replacement.event?.type).toBe('reaction.added');
    const count = await admin.query<{ count: string }>(
      `SELECT count(*) FROM reactions WHERE tenant_id = $1 AND message_id = $2`,
      [IDS.tenant, created.message.id],
    );
    expect(Number(count.rows[0]?.count)).toBe(MAX_MESSAGE_REACTION_MEMBERSHIPS);
  });

  it('rolls back a mutation when its completed domain event exceeds the outbox limit', async () => {
    const owner = context(IDS.owner);
    const source = await store.createMessage(owner, IDS.backend, key('postgres-event-cap-source'), {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Oversized work item source' }],
    });
    await expect(
      store.createWorkItem(owner, source.message.id, {
        type: 'action',
        title: 'Must roll back',
        externalReferences: [
          {
            provider: 'other',
            externalId: 'x'.repeat(MAX_DOMAIN_EVENT_JSON_BYTES + 10_000),
            url: 'https://example.com/oversized',
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 413,
      response: expect.objectContaining({ code: 'EVENT_TOO_LARGE' }),
    });
    const persisted = await admin.query<{ count: string }>(
      `SELECT count(*) FROM work_items WHERE tenant_id = $1 AND source_message_id = $2`,
      [IDS.tenant, source.message.id],
    );
    expect(Number(persisted.rows[0]?.count)).toBe(0);
  });

  it('keeps read state monotonic and derives bootstrap counts from stored state', async () => {
    const outsider = context(IDS.outsider);
    await store.createMessage(context(IDS.owner), IDS.backend, key('postgres-read-boundary'), {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Unread boundary for this integration run' }],
    });
    const bootstrap = await store.bootstrap(outsider);
    const channel = bootstrap.spaces
      .flatMap((space) => space.channels)
      .find((candidate) => candidate.id === IDS.backend);
    expect(channel).toBeDefined();
    expect(channel!.unreadCount).toBeGreaterThan(0);

    await expect(
      store.updateReadState(outsider, IDS.backend, {
        lastReadSequence: channel!.latestSequence + 1,
      }),
    ).rejects.toMatchObject({ status: 400 });

    const advanced = await store.updateReadState(outsider, IDS.backend, {
      lastReadSequence: channel!.latestSequence,
    });
    expect(advanced.event?.type).toBe('channel.read');
    expect(advanced.readState).toMatchObject({
      lastReadSequence: channel!.latestSequence,
      unreadCount: 0,
    });

    const stale = await store.updateReadState(outsider, IDS.backend, { lastReadSequence: 0 });
    expect(stale.event).toBeNull();
    expect(stale.readState.lastReadSequence).toBe(channel!.latestSequence);

    const refreshed = await store.bootstrap(outsider);
    const refreshedChannel = refreshed.spaces
      .flatMap((space) => space.channels)
      .find((candidate) => candidate.id === IDS.backend);
    expect(refreshedChannel).toMatchObject({
      lastReadSequence: channel!.latestSequence,
      unreadCount: 0,
    });
  });

  it('filters sync and unscoped work items by current private-channel membership', async () => {
    const owner = context(IDS.owner);
    const member = context(IDS.member);
    const privateMessage = await store.createMessage(
      owner,
      IDS.incidents,
      key('postgres-private-event'),
      {
        clientId: randomUUID(),
        blocks: [{ type: 'text', text: 'Private payload' }],
      },
    );
    const item = await store.createWorkItem(owner, privateMessage.message.id, {
      type: 'incident',
      title: 'Private incident',
      severity: 'sev2',
      externalReferences: [],
    });

    const beforeRemoval = await store.sync(member, privateMessage.event.cursor - 1, 100);
    expect(beforeRemoval.items.map((event) => event.id)).toContain(privateMessage.event.id);

    await admin.query(
      `
      DELETE FROM channel_memberships
      WHERE tenant_id = $1 AND channel_id = $2 AND user_id = $3
    `,
      [IDS.tenant, IDS.incidents, IDS.member],
    );
    try {
      const afterRemoval = await store.sync(member, privateMessage.event.cursor - 1, 100);
      expect(afterRemoval.items.map((event) => event.id)).not.toContain(privateMessage.event.id);
      const outsiderItems = await store.listWorkItems(context(IDS.outsider));
      expect(outsiderItems.map((workItem) => workItem.id)).not.toContain(item.item.id);
    } finally {
      await admin.query(
        `
        INSERT INTO channel_memberships (tenant_id, channel_id, user_id)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
      `,
        [IDS.tenant, IDS.incidents, IDS.member],
      );
    }
  });

  it('quarantines a legacy oversized outbox event without hiding it from sync', async () => {
    const legacyEventId = randomUUID();
    const inserted = await admin.query<{ cursor: string }>(
      `
      INSERT INTO domain_events (
        id, tenant_id, channel_id, audience_user_ids, event_type, payload
      ) VALUES ($1, $2, $3, ARRAY[$4]::uuid[], 'message.created', $5::jsonb)
      RETURNING cursor
    `,
      [
        legacyEventId,
        IDS.tenant,
        IDS.backend,
        IDS.owner,
        JSON.stringify({ legacy: 'x'.repeat(MAX_DOMAIN_EVENT_JSON_BYTES + 1_000) }),
      ],
    );
    const legacyCursor = Number(inserted.rows[0]!.cursor);
    const normal = await store.createMessage(
      context(IDS.owner),
      IDS.backend,
      key('postgres-after-legacy-oversized'),
      {
        clientId: randomUUID(),
        blocks: [{ type: 'text', text: 'Publish after quarantining the legacy event' }],
      },
    );
    const before = await store.recoverUnpublishedEvents(10_000, IDS.tenant);
    expect(before.map((event) => event.id)).toContain(legacyEventId);

    await store.quarantineEvent(IDS.tenant, legacyEventId, 'legacy event exceeds transport limit');
    const recovered = await store.recoverUnpublishedEvents(10_000, IDS.tenant);
    expect(recovered.map((event) => event.id)).not.toContain(legacyEventId);
    expect(recovered.map((event) => event.id)).toContain(normal.event.id);
    const sync = await store.sync(context(IDS.owner), legacyCursor - 1, 100);
    expect(sync.items.map((event) => event.id)).toContain(legacyEventId);

    const quarantine = await admin.query<{
      outbox_quarantined_at: Date | null;
      outbox_error: string | null;
    }>(
      `
      SELECT outbox_quarantined_at, outbox_error
      FROM domain_events
      WHERE tenant_id = $1 AND id = $2
    `,
      [IDS.tenant, legacyEventId],
    );
    expect(quarantine.rows[0]?.outbox_quarantined_at).not.toBeNull();
    expect(quarantine.rows[0]?.outbox_error).toBe('legacy event exceeds transport limit');
  });

  it('preserves historical outbox events when a channel is hard-deleted', async () => {
    const channelId = randomUUID();
    await admin.query(
      `
      INSERT INTO channels (id, tenant_id, name, slug, description, kind, next_sequence)
      VALUES ($1, $2, 'Disposable channel', $3, '', 'public', 0)
    `,
      [channelId, IDS.tenant, `disposable-${runId}`],
    );

    const created = await store.createMessage(
      context(IDS.owner),
      channelId,
      key('postgres-disposable-channel'),
      {
        clientId: randomUUID(),
        blocks: [{ type: 'text', text: 'Historical event' }],
      },
    );
    await admin.query(`DELETE FROM channels WHERE tenant_id = $1 AND id = $2`, [
      IDS.tenant,
      channelId,
    ]);

    const historical = await admin.query<{ channel_id: string | null }>(
      `SELECT channel_id FROM domain_events WHERE tenant_id = $1 AND id = $2`,
      [IDS.tenant, created.event.id],
    );
    expect(historical.rows[0]?.channel_id).toBeNull();

    const sync = await store.sync(context(IDS.owner), created.event.cursor - 1, 100);
    expect(sync.items.map((event) => event.id)).not.toContain(created.event.id);
  });
});
