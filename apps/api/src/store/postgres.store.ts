import { ForbiddenException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BootstrapResponse,
  Channel,
  CreateMessageInput,
  CreateWorkItemInput,
  CursorPage,
  DomainEvent,
  Message,
  MessageBlock,
  Space,
  User,
  WorkItem,
} from '@work-chat/contracts';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { AppContext } from '../common/context.js';
import { encodeCursor } from '../common/cursor.js';
import type { Store } from './store.js';

interface MessageRow extends QueryResultRow {
  id: string;
  channel_id: string;
  thread_root_id: string | null;
  sequence: string;
  author_id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
  blocks: MessageBlock[];
  revision: number;
  reply_count: string;
  reactions: Record<string, string[]> | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
}

@Injectable()
export class PostgresStore implements Store, OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({ connectionString: config.getOrThrow<string>('DATABASE_URL'), max: 20 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async bootstrap(context: AppContext): Promise<BootstrapResponse> {
    return this.withTenant(context, async (client) => {
      const membership = await client.query(`
        SELECT o.id, o.name, o.slug, u.id AS user_id, u.display_name, u.email, u.avatar_url
        FROM memberships m
        JOIN organizations o ON o.id = m.tenant_id
        JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.user_id = $2
      `, [context.tenantId, context.userId]);
      const row = membership.rows[0];
      if (!row) throw new ForbiddenException('User is not a member of this organization');
      const channelResult = await client.query(`
        SELECT c.id, c.space_id, c.name, c.slug, c.description, c.kind,
               s.name AS space_name, s.slug AS space_slug
        FROM channels c
        LEFT JOIN spaces s ON s.id = c.space_id
        WHERE c.tenant_id = $1
          AND (c.kind = 'public' OR EXISTS (
            SELECT 1 FROM channel_memberships cm WHERE cm.channel_id = c.id AND cm.user_id = $2
          ))
        ORDER BY s.name NULLS LAST, c.name
      `, [context.tenantId, context.userId]);
      const spaces = new Map<string, Space>();
      const directMessages: Channel[] = [];
      for (const channelRow of channelResult.rows) {
        const channel: Channel = {
          id: channelRow.id,
          spaceId: channelRow.space_id,
          name: channelRow.name,
          slug: channelRow.slug,
          description: channelRow.description,
          kind: channelRow.kind,
          unreadCount: 0,
        };
        if (!channelRow.space_id) {
          directMessages.push(channel);
          continue;
        }
        const existing: Space = spaces.get(channelRow.space_id) ?? {
          id: channelRow.space_id,
          name: channelRow.space_name,
          slug: channelRow.space_slug,
          channels: [],
        };
        existing.channels.push(channel);
        spaces.set(existing.id, existing);
      }
      const currentUser: User = {
        id: row.user_id,
        displayName: row.display_name,
        email: row.email,
        avatarUrl: row.avatar_url,
        status: 'online',
      };
      return {
        organization: { id: row.id, name: row.name, slug: row.slug },
        currentUser,
        spaces: [...spaces.values()],
        directMessages,
      };
    });
  }

  async listMessages(context: AppContext, channelId: string, afterSequence: number, limit: number): Promise<CursorPage<Message>> {
    return this.withTenant(context, async (client) => {
      await this.assertChannel(client, context, channelId);
      const result = await client.query<MessageRow>(`
        SELECT m.*, u.display_name, u.email, u.avatar_url,
          (SELECT count(*) FROM messages replies WHERE replies.thread_root_id = m.id) AS reply_count,
          COALESCE((
            SELECT jsonb_object_agg(grouped.emoji, grouped.user_ids)
            FROM (SELECT emoji, jsonb_agg(user_id) AS user_ids FROM reactions r WHERE r.message_id = m.id GROUP BY emoji) grouped
          ), '{}'::jsonb) AS reactions
        FROM messages m JOIN users u ON u.id = m.author_id
        WHERE m.channel_id = $1 AND m.sequence > $2
        ORDER BY m.sequence ASC LIMIT $3
      `, [channelId, afterSequence, limit]);
      const items = result.rows.map(toMessage);
      const last = items.at(-1);
      return { items, nextCursor: last ? encodeCursor(last.sequence) : null };
    });
  }

  async createMessage(context: AppContext, channelId: string, idempotencyKey: string, input: CreateMessageInput): Promise<{ message: Message; event: DomainEvent; reused: boolean }> {
    return this.withTenant(context, async (client) => {
      await this.assertChannel(client, context, channelId);
      const scope = `channel:${channelId}:message.create`;
      const cached = await client.query(`SELECT response FROM idempotency_keys WHERE tenant_id=$1 AND user_id=$2 AND scope=$3 AND idempotency_key=$4`, [context.tenantId, context.userId, scope, idempotencyKey]);
      if (cached.rows[0]) return { ...cached.rows[0].response, reused: true };

      const sequenceResult = await client.query(`UPDATE channels SET next_sequence = next_sequence + 1 WHERE id=$1 RETURNING next_sequence`, [channelId]);
      const sequence = Number(sequenceResult.rows[0].next_sequence);
      const messageId = randomUUID();
      const inserted = await client.query<MessageRow>(`
        WITH inserted AS (
          INSERT INTO messages (id, tenant_id, channel_id, thread_root_id, sequence, author_id, blocks)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *
        )
        SELECT inserted.*, u.display_name, u.email, u.avatar_url, 0::bigint AS reply_count, '{}'::jsonb AS reactions
        FROM inserted JOIN users u ON u.id = inserted.author_id
      `, [messageId, context.tenantId, channelId, input.threadRootId ?? null, sequence, context.userId, JSON.stringify(input.blocks)]);
      const message = toMessage(inserted.rows[0]!);
      const audience = await this.audience(client, context.tenantId, channelId);
      const event = await this.insertEvent(client, context, 'message.created', audience, { message });
      await client.query(`INSERT INTO idempotency_keys (tenant_id,user_id,scope,idempotency_key,response) VALUES ($1,$2,$3,$4,$5::jsonb)`, [context.tenantId, context.userId, scope, idempotencyKey, JSON.stringify({ message, event })]);
      await this.audit(client, context, 'message.created', 'message', message.id, { channelId });
      return { message, event, reused: false };
    });
  }

  async createWorkItem(context: AppContext, messageId: string, input: CreateWorkItemInput): Promise<{ item: WorkItem; event: DomainEvent }> {
    return this.withTenant(context, async (client) => {
      const source = await client.query(`SELECT channel_id FROM messages WHERE id=$1`, [messageId]);
      if (!source.rows[0]) throw new NotFoundException('Source message not found');
      const channelId = source.rows[0].channel_id;
      await this.assertChannel(client, context, channelId);
      const inserted = await client.query(`
        INSERT INTO work_items (tenant_id,channel_id,source_message_id,type,title,owner_id,due_at,severity,external_references)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *
      `, [context.tenantId, channelId, messageId, input.type, input.title, input.ownerId ?? null, input.dueAt ?? null, input.type === 'incident' ? (input.severity ?? 'sev3') : null, JSON.stringify(input.externalReferences)]);
      const item = toWorkItem(inserted.rows[0]);
      const audience = await this.audience(client, context.tenantId, channelId);
      const event = await this.insertEvent(client, context, 'work_item.created', audience, { workItem: item });
      await this.audit(client, context, 'work_item.created', 'work_item', item.id, { type: item.type, sourceMessageId: messageId });
      return { item, event };
    });
  }

  async listWorkItems(context: AppContext, channelId?: string): Promise<WorkItem[]> {
    return this.withTenant(context, async (client) => {
      if (channelId) await this.assertChannel(client, context, channelId);
      const result = await client.query(`SELECT * FROM work_items WHERE tenant_id=$1 AND ($2::uuid IS NULL OR channel_id=$2) ORDER BY updated_at DESC LIMIT 200`, [context.tenantId, channelId ?? null]);
      return result.rows.map(toWorkItem);
    });
  }

  async sync(context: AppContext, afterCursor: number, limit: number): Promise<CursorPage<DomainEvent>> {
    return this.withTenant(context, async (client) => {
      const result = await client.query(`
        SELECT cursor,id,tenant_id,audience_user_ids,event_type,event_version,payload,occurred_at
        FROM domain_events WHERE tenant_id=$1 AND cursor>$2 AND audience_user_ids @> ARRAY[$3]::uuid[]
        ORDER BY cursor ASC LIMIT $4
      `, [context.tenantId, afterCursor, context.userId, limit]);
      const items = result.rows.map(toEvent);
      const last = items.at(-1);
      return { items, nextCursor: last ? encodeCursor(last.cursor) : null };
    });
  }

  async recoverUnpublishedEvents(limit: number): Promise<DomainEvent[]> {
    const tenants = await this.pool.query<{ id: string }>('SELECT id FROM organizations ORDER BY created_at');
    const events: DomainEvent[] = [];
    for (const tenant of tenants.rows) {
      if (events.length >= limit) break;
      const context: AppContext = { tenantId: tenant.id, userId: tenant.id, roles: ['system'], requestId: 'outbox-recovery' };
      const tenantEvents = await this.withTenant(context, async (client) => {
        const result = await client.query(`
          SELECT cursor,id,tenant_id,audience_user_ids,event_type,event_version,payload,occurred_at
          FROM domain_events WHERE tenant_id=$1 AND published_at IS NULL
          ORDER BY cursor ASC LIMIT $2
        `, [tenant.id, limit - events.length]);
        return result.rows.map(toEvent);
      });
      events.push(...tenantEvents);
    }
    return events;
  }

  async markEventPublished(tenantId: string, eventId: string): Promise<void> {
    const context: AppContext = { tenantId, userId: tenantId, roles: ['system'], requestId: 'outbox-publisher' };
    await this.withTenant(context, async (client) => {
      await client.query('UPDATE domain_events SET published_at=COALESCE(published_at, now()) WHERE id=$1', [eventId]);
    });
  }

  private async withTenant<T>(context: AppContext, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [context.tenantId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertChannel(client: PoolClient, context: AppContext, channelId: string): Promise<void> {
    const result = await client.query(`
      SELECT 1 FROM channels c JOIN memberships m ON m.tenant_id=c.tenant_id AND m.user_id=$2
      WHERE c.id=$1 AND (c.kind='public' OR EXISTS (SELECT 1 FROM channel_memberships cm WHERE cm.channel_id=c.id AND cm.user_id=$2))
    `, [channelId, context.userId]);
    if (!result.rows[0]) throw new ForbiddenException('Channel access denied');
  }

  private async audience(client: PoolClient, tenantId: string, channelId: string): Promise<string[]> {
    const result = await client.query(`
      SELECT m.user_id FROM memberships m JOIN channels c ON c.tenant_id=m.tenant_id
      WHERE c.id=$2 AND m.tenant_id=$1 AND (c.kind='public' OR EXISTS (SELECT 1 FROM channel_memberships cm WHERE cm.channel_id=c.id AND cm.user_id=m.user_id))
    `, [tenantId, channelId]);
    return result.rows.map((row) => row.user_id);
  }

  private async insertEvent(client: PoolClient, context: AppContext, type: DomainEvent['type'], audience: string[], payload: Record<string, unknown>): Promise<DomainEvent> {
    const id = randomUUID();
    const result = await client.query(`
      INSERT INTO domain_events (id,tenant_id,audience_user_ids,event_type,payload)
      VALUES ($1,$2,$3::uuid[],$4,$5::jsonb)
      RETURNING cursor,id,tenant_id,audience_user_ids,event_type,event_version,payload,occurred_at
    `, [id, context.tenantId, audience, type, JSON.stringify(payload)]);
    return toEvent(result.rows[0]);
  }

  private async audit(client: PoolClient, context: AppContext, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
    await client.query(`INSERT INTO audit_events (tenant_id,actor_id,action,target_type,target_id,metadata,request_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [context.tenantId, context.userId, action, targetType, targetId, JSON.stringify(metadata), context.requestId]);
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    threadRootId: row.thread_root_id,
    sequence: Number(row.sequence),
    author: { id: row.author_id, displayName: row.display_name, email: row.email, avatarUrl: row.avatar_url, status: 'offline' },
    blocks: row.blocks,
    revision: row.revision,
    replyCount: Number(row.reply_count),
    reactions: row.reactions ?? {},
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
  };
}

function toWorkItem(row: any): WorkItem {
  return {
    id: row.id,
    channelId: row.channel_id,
    sourceMessageId: row.source_message_id,
    type: row.type,
    title: row.title,
    status: row.status,
    ownerId: row.owner_id,
    dueAt: row.due_at?.toISOString() ?? null,
    severity: row.severity,
    externalReferences: row.external_references,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEvent(row: any): DomainEvent {
  return {
    id: row.id,
    cursor: Number(row.cursor),
    version: 1,
    tenantId: row.tenant_id,
    audienceUserIds: row.audience_user_ids,
    type: row.event_type,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
  };
}
