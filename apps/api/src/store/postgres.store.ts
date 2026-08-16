import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MAX_DOMAIN_EVENT_JSON_BYTES,
  MAX_MESSAGE_REACTION_MEMBERSHIPS,
  type BootstrapResponse,
  type Channel,
  type CreateMessageInput,
  type CreateWorkItemInput,
  type CursorPage,
  type DeleteMessageInput,
  type DomainEvent,
  type Message,
  type MessageBlock,
  type MessageThread,
  type ReactionInput,
  type ReadState,
  type Space,
  type UpdateMessageInput,
  type UpdateReadStateInput,
  type User,
  type WorkItem,
} from '@work-chat/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { AppContext } from '../common/context.js';
import { encodeCursor } from '../common/cursor.js';
import type { Store } from './store.js';

type MembershipRole = 'owner' | 'admin' | 'member';

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
  membership_role?: MembershipRole;
}

interface ChannelAccessRow extends QueryResultRow {
  next_sequence: string;
}

interface ReadStateRow extends QueryResultRow {
  channel_id: string;
  last_read_sequence: string;
  unread_count?: string;
  updated_at: Date;
}

interface CachedResponseRow extends QueryResultRow {
  request_hash: string | null;
  response: unknown;
}

const MESSAGE_PROJECTION = `
  m.id,
  m.channel_id,
  m.thread_root_id,
  m.sequence,
  m.author_id,
  m.blocks,
  m.revision,
  m.created_at,
  m.edited_at,
  m.deleted_at,
  u.display_name,
  u.email,
  u.avatar_url,
  (SELECT count(*) FROM messages replies
    WHERE replies.tenant_id = m.tenant_id
      AND replies.channel_id = m.channel_id
      AND replies.thread_root_id = m.id) AS reply_count,
  COALESCE((
    SELECT jsonb_object_agg(grouped.emoji, grouped.user_ids)
    FROM (
      SELECT r.emoji, jsonb_agg(r.user_id ORDER BY r.created_at, r.user_id) AS user_ids
      FROM reactions r
      WHERE r.tenant_id = m.tenant_id AND r.message_id = m.id
      GROUP BY r.emoji
    ) grouped
  ), '{}'::jsonb) AS reactions
`;

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
      const membership = await client.query(
        `
        SELECT o.id, o.name, o.slug, u.id AS user_id, u.display_name, u.email, u.avatar_url
        FROM memberships m
        JOIN organizations o ON o.id = m.tenant_id
        JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.user_id = $2
      `,
        [context.tenantId, context.userId],
      );
      const row = membership.rows[0];
      if (!row) throw new ForbiddenException('User is not a member of this organization');

      const channelResult = await client.query(
        `
        SELECT
          c.id,
          c.space_id,
          c.name,
          c.slug,
          c.description,
          c.kind,
          c.next_sequence AS latest_sequence,
          COALESCE(read_state.last_read_sequence, 0) AS last_read_sequence,
          (
            SELECT count(*)
            FROM messages unread
            WHERE unread.tenant_id = c.tenant_id
              AND unread.channel_id = c.id
              AND unread.sequence > COALESCE(read_state.last_read_sequence, 0)
              AND unread.author_id <> $2
              AND unread.deleted_at IS NULL
          ) AS unread_count,
          s.name AS space_name,
          s.slug AS space_slug
        FROM channels c
        LEFT JOIN spaces s ON s.tenant_id = c.tenant_id AND s.id = c.space_id
        LEFT JOIN channel_read_states read_state
          ON read_state.tenant_id = c.tenant_id
          AND read_state.channel_id = c.id
          AND read_state.user_id = $2
        WHERE c.tenant_id = $1
          AND EXISTS (
            SELECT 1 FROM memberships member
            WHERE member.tenant_id = c.tenant_id AND member.user_id = $2
          )
          AND (c.kind = 'public' OR EXISTS (
            SELECT 1 FROM channel_memberships cm
            WHERE cm.tenant_id = c.tenant_id
              AND cm.channel_id = c.id
              AND cm.user_id = $2
          ))
        ORDER BY s.name NULLS LAST, c.name
      `,
        [context.tenantId, context.userId],
      );

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
          latestSequence: Number(channelRow.latest_sequence),
          lastReadSequence: Number(channelRow.last_read_sequence),
          unreadCount: Number(channelRow.unread_count),
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

  async listMessages(
    context: AppContext,
    channelId: string,
    afterSequence: number,
    limit: number,
  ): Promise<CursorPage<Message>> {
    return this.withTenant(context, async (client) => {
      await this.assertChannel(client, context, channelId);
      const result = await client.query<MessageRow>(
        `
        SELECT ${MESSAGE_PROJECTION}
        FROM messages m
        JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1
          AND m.channel_id = $2
          AND m.thread_root_id IS NULL
          AND m.sequence > $3
        ORDER BY m.sequence ASC
        LIMIT $4
      `,
        [context.tenantId, channelId, afterSequence, limit],
      );
      const items = result.rows.map(toMessage);
      const last = items.at(-1);
      return { items, nextCursor: last ? encodeCursor(last.sequence) : null };
    });
  }

  async getThread(
    context: AppContext,
    rootMessageId: string,
    afterSequence: number,
    limit: number,
  ): Promise<MessageThread> {
    return this.withTenant(context, async (client) => {
      const rootRow = await this.loadAccessibleMessage(client, context, rootMessageId, false);
      if (rootRow.thread_root_id !== null) {
        throw new BadRequestException({
          code: 'THREAD_ROOT_REQUIRED',
          message: 'A thread must be loaded by its root message',
        });
      }
      const replyResult = await client.query<MessageRow>(
        `
        SELECT ${MESSAGE_PROJECTION}
        FROM messages m
        JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1
          AND m.channel_id = $2
          AND m.thread_root_id = $3
          AND m.sequence > $4
        ORDER BY m.sequence ASC
        LIMIT $5
      `,
        [context.tenantId, rootRow.channel_id, rootMessageId, afterSequence, limit],
      );
      const replies = replyResult.rows.map(toMessage);
      const last = replies.at(-1);
      return {
        root: toMessage(rootRow),
        replies,
        nextCursor: last ? encodeCursor(last.sequence) : null,
      };
    });
  }

  async createMessage(
    context: AppContext,
    channelId: string,
    idempotencyKey: string,
    input: CreateMessageInput,
  ): Promise<{ message: Message; event: DomainEvent; reused: boolean }> {
    return this.withTenant(context, async (client) => {
      await this.assertChannel(client, context, channelId);
      const scope = `channel:${channelId}:message.create`;
      const hash = hashRequest(input);
      const cached = await this.getIdempotentResponse<{ message: Message; event: DomainEvent }>(
        client,
        context,
        scope,
        idempotencyKey,
        hash,
      );
      if (cached) return { ...cached, reused: true };

      if (input.threadRootId) {
        const root = await client.query(
          `
          SELECT id
          FROM messages
          WHERE tenant_id = $1
            AND channel_id = $2
            AND id = $3
            AND thread_root_id IS NULL
            AND deleted_at IS NULL
          FOR UPDATE
        `,
          [context.tenantId, channelId, input.threadRootId],
        );
        if (!root.rows[0]) {
          throw new BadRequestException({
            code: 'INVALID_THREAD_ROOT',
            message: 'Thread root must be an active root message in the same channel',
          });
        }
      }

      const sequenceResult = await client.query<ChannelAccessRow>(
        `
        UPDATE channels
        SET next_sequence = next_sequence + 1
        WHERE tenant_id = $1 AND id = $2
        RETURNING next_sequence
      `,
        [context.tenantId, channelId],
      );
      const sequence = Number(sequenceResult.rows[0]!.next_sequence);
      const messageId = randomUUID();
      await client.query(
        `
        INSERT INTO messages (
          id, tenant_id, channel_id, thread_root_id, sequence, author_id, blocks
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
        [
          messageId,
          context.tenantId,
          channelId,
          input.threadRootId ?? null,
          sequence,
          context.userId,
          JSON.stringify(input.blocks),
        ],
      );

      const messageRow = await this.loadMessage(client, context.tenantId, messageId);
      if (!messageRow) throw new Error('Inserted message is missing');
      const message = toMessage(messageRow);
      let threadRoot: Message | null = null;
      if (input.threadRootId) {
        const threadRootRow = await this.loadMessage(client, context.tenantId, input.threadRootId);
        if (!threadRootRow) throw new Error('Thread root is missing after reply creation');
        threadRoot = toMessage(threadRootRow);
      }

      const audience = await this.audience(client, context.tenantId, channelId);
      const event = await this.insertEvent(
        client,
        context,
        channelId,
        'message.created',
        audience,
        { message, threadRoot },
      );
      await this.audit(client, context, 'message.created', 'message', message.id, {
        channelId,
        threadRootId: input.threadRootId ?? null,
      });
      await this.saveIdempotentResponse(client, context, scope, idempotencyKey, hash, {
        message,
        event,
      });
      return { message, event, reused: false };
    });
  }

  async updateMessage(
    context: AppContext,
    messageId: string,
    idempotencyKey: string,
    input: UpdateMessageInput,
  ): Promise<{ message: Message; event: DomainEvent; reused: boolean }> {
    return this.withTenant(context, async (client) => {
      const current = await this.loadAccessibleMessage(client, context, messageId, true);
      if (current.author_id !== context.userId) {
        throw new ForbiddenException({
          code: 'MESSAGE_EDIT_FORBIDDEN',
          message: 'Only the message author can edit it',
        });
      }

      const scope = `message:${messageId}:update`;
      const hash = hashRequest(input);
      const cached = await this.getIdempotentResponse<{ message: Message; event: DomainEvent }>(
        client,
        context,
        scope,
        idempotencyKey,
        hash,
      );
      if (cached) return { ...cached, reused: true };
      this.assertMutable(current);
      this.assertRevision(current.revision, input.expectedRevision);

      await this.snapshotRevision(client, context, current);
      const updated = await client.query(
        `
        UPDATE messages
        SET blocks = $4::jsonb,
            revision = revision + 1,
            edited_at = now()
        WHERE tenant_id = $1
          AND id = $2
          AND revision = $3
          AND deleted_at IS NULL
        RETURNING id
      `,
        [context.tenantId, messageId, input.expectedRevision, JSON.stringify(input.blocks)],
      );
      if (!updated.rows[0]) this.throwRevisionConflict();

      const messageRow = await this.loadMessage(client, context.tenantId, messageId);
      if (!messageRow) throw new Error('Updated message is missing');
      const message = toMessage(messageRow);
      const audience = await this.audience(client, context.tenantId, current.channel_id);
      const event = await this.insertEvent(
        client,
        context,
        current.channel_id,
        'message.updated',
        audience,
        { message },
      );
      await this.audit(client, context, 'message.updated', 'message', message.id, {
        channelId: current.channel_id,
        previousRevision: current.revision,
        revision: message.revision,
      });
      await this.saveIdempotentResponse(client, context, scope, idempotencyKey, hash, {
        message,
        event,
      });
      return { message, event, reused: false };
    });
  }

  async deleteMessage(
    context: AppContext,
    messageId: string,
    idempotencyKey: string,
    input: DeleteMessageInput,
  ): Promise<{ message: Message; event: DomainEvent; reused: boolean }> {
    return this.withTenant(context, async (client) => {
      const current = await this.loadAccessibleMessage(client, context, messageId, true);
      const canModerate =
        current.membership_role === 'owner' || current.membership_role === 'admin';
      if (current.author_id !== context.userId && !canModerate) {
        throw new ForbiddenException({
          code: 'MESSAGE_DELETE_FORBIDDEN',
          message: 'Only the author or an organization administrator can delete this message',
        });
      }

      const scope = `message:${messageId}:delete`;
      const hash = hashRequest(input);
      const cached = await this.getIdempotentResponse<{ message: Message; event: DomainEvent }>(
        client,
        context,
        scope,
        idempotencyKey,
        hash,
      );
      if (cached) return { ...cached, reused: true };
      this.assertMutable(current);
      this.assertRevision(current.revision, input.expectedRevision);

      await this.snapshotRevision(client, context, current);
      const deleted = await client.query(
        `
        UPDATE messages
        SET blocks = '[]'::jsonb,
            revision = revision + 1,
            deleted_at = now()
        WHERE tenant_id = $1
          AND id = $2
          AND revision = $3
          AND deleted_at IS NULL
        RETURNING id
      `,
        [context.tenantId, messageId, input.expectedRevision],
      );
      if (!deleted.rows[0]) this.throwRevisionConflict();
      await client.query(
        `
        DELETE FROM reactions
        WHERE tenant_id = $1 AND message_id = $2
      `,
        [context.tenantId, messageId],
      );

      const messageRow = await this.loadMessage(client, context.tenantId, messageId);
      if (!messageRow) throw new Error('Deleted message tombstone is missing');
      const message = toMessage(messageRow);
      await this.sanitizeDeletedMessageHistory(client, context, message);
      const audience = await this.audience(client, context.tenantId, current.channel_id);
      const event = await this.insertEvent(
        client,
        context,
        current.channel_id,
        'message.deleted',
        audience,
        { message },
      );
      await this.audit(client, context, 'message.deleted', 'message', message.id, {
        channelId: current.channel_id,
        previousRevision: current.revision,
        revision: message.revision,
      });
      await this.saveIdempotentResponse(client, context, scope, idempotencyKey, hash, {
        message,
        event,
      });
      return { message, event, reused: false };
    });
  }

  async setReaction(
    context: AppContext,
    messageId: string,
    input: ReactionInput,
    present: boolean,
  ): Promise<{ message: Message; event: DomainEvent | null }> {
    return this.withTenant(context, async (client) => {
      const current = await this.loadAccessibleMessage(client, context, messageId, true);
      this.assertMutable(current);

      const mutation = present
        ? await client.query(
            `
            INSERT INTO reactions (tenant_id, message_id, user_id, emoji)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
            RETURNING message_id
          `,
            [context.tenantId, messageId, context.userId, input.emoji],
          )
        : await client.query(
            `
            DELETE FROM reactions
            WHERE tenant_id = $1 AND message_id = $2 AND user_id = $3 AND emoji = $4
            RETURNING message_id
          `,
            [context.tenantId, messageId, context.userId, input.emoji],
          );

      if (present && mutation.rows[0]) {
        const count = await client.query<{ count: string }>(
          `
          SELECT count(*)
          FROM reactions
          WHERE tenant_id = $1 AND message_id = $2
        `,
          [context.tenantId, messageId],
        );
        if (Number(count.rows[0]!.count) > MAX_MESSAGE_REACTION_MEMBERSHIPS) {
          throw new BadRequestException({
            code: 'REACTION_LIMIT_REACHED',
            message: `A message cannot have more than ${MAX_MESSAGE_REACTION_MEMBERSHIPS} reaction memberships`,
          });
        }
      }

      const messageRow = await this.loadMessage(client, context.tenantId, messageId);
      if (!messageRow) throw new Error('Reaction target is missing');
      const message = toMessage(messageRow);
      if (!mutation.rows[0]) return { message, event: null };

      const type: DomainEvent['type'] = present ? 'reaction.added' : 'reaction.removed';
      const audience = await this.audience(client, context.tenantId, current.channel_id);
      const event = await this.insertEvent(client, context, current.channel_id, type, audience, {
        message,
      });
      await this.audit(client, context, type, 'message', message.id, {
        channelId: current.channel_id,
        emoji: input.emoji,
      });
      return { message, event };
    });
  }

  async updateReadState(
    context: AppContext,
    channelId: string,
    input: UpdateReadStateInput,
  ): Promise<{ readState: ReadState; event: DomainEvent | null }> {
    return this.withTenant(context, async (client) => {
      const channel = await this.assertChannel(client, context, channelId);
      const latestSequence = Number(channel.next_sequence);
      if (input.lastReadSequence > latestSequence) {
        throw new BadRequestException({
          code: 'READ_SEQUENCE_OUT_OF_RANGE',
          message: 'Read sequence is newer than the channel',
        });
      }

      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `${context.tenantId}:${context.userId}:${channelId}:read-state`,
      ]);
      const previousResult = await client.query<ReadStateRow>(
        `
        SELECT channel_id, last_read_sequence, updated_at
        FROM channel_read_states
        WHERE tenant_id = $1 AND channel_id = $2 AND user_id = $3
        FOR UPDATE
      `,
        [context.tenantId, channelId, context.userId],
      );
      const previous = previousResult.rows[0];
      const previousSequence = previous ? Number(previous.last_read_sequence) : 0;
      const nextSequence = Math.max(previousSequence, input.lastReadSequence);
      const changed = nextSequence > previousSequence;

      let stored: ReadStateRow;
      if (!previous) {
        const inserted = await client.query<ReadStateRow>(
          `
          INSERT INTO channel_read_states (
            tenant_id, channel_id, user_id, last_read_sequence
          ) VALUES ($1, $2, $3, $4)
          RETURNING channel_id, last_read_sequence, updated_at
        `,
          [context.tenantId, channelId, context.userId, nextSequence],
        );
        stored = inserted.rows[0]!;
      } else if (changed) {
        const updated = await client.query<ReadStateRow>(
          `
          UPDATE channel_read_states
          SET last_read_sequence = $4, updated_at = now()
          WHERE tenant_id = $1 AND channel_id = $2 AND user_id = $3
          RETURNING channel_id, last_read_sequence, updated_at
        `,
          [context.tenantId, channelId, context.userId, nextSequence],
        );
        stored = updated.rows[0]!;
      } else {
        stored = previous;
      }

      const unreadResult = await client.query<{ count: string }>(
        `
        SELECT count(*)
        FROM messages
        WHERE tenant_id = $1
          AND channel_id = $2
          AND sequence > $3
          AND author_id <> $4
          AND deleted_at IS NULL
      `,
        [context.tenantId, channelId, nextSequence, context.userId],
      );
      const readState: ReadState = {
        channelId,
        lastReadSequence: nextSequence,
        unreadCount: Number(unreadResult.rows[0]!.count),
        updatedAt: stored.updated_at.toISOString(),
      };
      if (!changed) return { readState, event: null };

      const event = await this.insertEvent(
        client,
        context,
        channelId,
        'channel.read',
        [context.userId],
        { readState },
      );
      await this.audit(client, context, 'channel.read', 'channel', channelId, {
        lastReadSequence: nextSequence,
      });
      return { readState, event };
    });
  }

  async createWorkItem(
    context: AppContext,
    messageId: string,
    input: CreateWorkItemInput,
  ): Promise<{ item: WorkItem; event: DomainEvent }> {
    return this.withTenant(context, async (client) => {
      const source = await this.loadAccessibleMessage(client, context, messageId, true);
      this.assertMutable(source);
      if (input.ownerId) {
        const owner = await client.query(
          `
          SELECT 1 FROM memberships
          WHERE tenant_id = $1 AND user_id = $2
        `,
          [context.tenantId, input.ownerId],
        );
        if (!owner.rows[0]) {
          throw new BadRequestException({
            code: 'INVALID_WORK_ITEM_OWNER',
            message: 'Work item owner must belong to the organization',
          });
        }
      }

      const inserted = await client.query(
        `
        INSERT INTO work_items (
          tenant_id, channel_id, source_message_id, type, title,
          owner_id, due_at, severity, external_references
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *
      `,
        [
          context.tenantId,
          source.channel_id,
          messageId,
          input.type,
          input.title,
          input.ownerId ?? null,
          input.dueAt ?? null,
          input.type === 'incident' ? (input.severity ?? 'sev3') : null,
          JSON.stringify(input.externalReferences),
        ],
      );
      const item = toWorkItem(inserted.rows[0]);
      const audience = await this.audience(client, context.tenantId, source.channel_id);
      const event = await this.insertEvent(
        client,
        context,
        source.channel_id,
        'work_item.created',
        audience,
        { workItem: item },
      );
      await this.audit(client, context, 'work_item.created', 'work_item', item.id, {
        type: item.type,
        sourceMessageId: messageId,
      });
      return { item, event };
    });
  }

  async listWorkItems(context: AppContext, channelId?: string): Promise<WorkItem[]> {
    return this.withTenant(context, async (client) => {
      if (channelId) await this.assertChannel(client, context, channelId);
      const result = await client.query(
        `
        SELECT wi.*
        FROM work_items wi
        JOIN channels c ON c.tenant_id = wi.tenant_id AND c.id = wi.channel_id
        JOIN memberships member
          ON member.tenant_id = wi.tenant_id AND member.user_id = $2
        WHERE wi.tenant_id = $1
          AND ($3::uuid IS NULL OR wi.channel_id = $3)
          AND (c.kind = 'public' OR EXISTS (
            SELECT 1 FROM channel_memberships cm
            WHERE cm.tenant_id = c.tenant_id
              AND cm.channel_id = c.id
              AND cm.user_id = $2
          ))
        ORDER BY wi.updated_at DESC
        LIMIT 200
      `,
        [context.tenantId, context.userId, channelId ?? null],
      );
      return result.rows.map(toWorkItem);
    });
  }

  async sync(
    context: AppContext,
    afterCursor: number,
    limit: number,
  ): Promise<CursorPage<DomainEvent>> {
    return this.withTenant(context, async (client) => {
      const result = await client.query(
        `
        SELECT
          event.cursor,
          event.id,
          event.tenant_id,
          event.channel_id,
          event.audience_user_ids,
          event.event_type,
          event.event_version,
          event.payload,
          event.occurred_at
        FROM domain_events event
        JOIN channels c
          ON c.tenant_id = event.tenant_id AND c.id = event.channel_id
        JOIN memberships member
          ON member.tenant_id = event.tenant_id AND member.user_id = $3
        WHERE event.tenant_id = $1
          AND event.cursor > $2
          AND event.audience_user_ids @> ARRAY[$3]::uuid[]
          AND (c.kind = 'public' OR EXISTS (
            SELECT 1 FROM channel_memberships cm
            WHERE cm.tenant_id = c.tenant_id
              AND cm.channel_id = c.id
              AND cm.user_id = $3
          ))
        ORDER BY event.cursor ASC
        LIMIT $4
      `,
        [context.tenantId, afterCursor, context.userId, limit],
      );
      const items = result.rows.map(toEvent);
      const last = items.at(-1);
      return { items, nextCursor: last ? encodeCursor(last.cursor) : null };
    });
  }

  async recoverUnpublishedEvents(limit: number, tenantId?: string): Promise<DomainEvent[]> {
    if (tenantId) return this.recoverTenantUnpublishedEvents(tenantId, limit);
    const tenants = await this.pool.query<{ id: string }>(
      'SELECT id FROM organizations ORDER BY created_at',
    );
    const events: DomainEvent[] = [];
    for (const tenant of tenants.rows) {
      const tenantEvents = await this.recoverTenantUnpublishedEvents(tenant.id, limit);
      events.push(...tenantEvents);
    }
    return events.sort((left, right) => left.cursor - right.cursor).slice(0, limit);
  }

  private async recoverTenantUnpublishedEvents(
    tenantId: string,
    limit: number,
  ): Promise<DomainEvent[]> {
    const context: AppContext = {
      tenantId,
      userId: tenantId,
      roles: ['system'],
      requestId: 'outbox-recovery',
    };
    return this.withTenant(context, async (client) => {
      const result = await client.query(
        `
        SELECT
          cursor, id, tenant_id, channel_id, audience_user_ids, event_type,
          event_version, payload, occurred_at
        FROM domain_events
        WHERE tenant_id = $1
          AND published_at IS NULL
          AND outbox_quarantined_at IS NULL
        ORDER BY cursor ASC
        LIMIT $2
      `,
        [tenantId, limit],
      );
      return result.rows.map(toEvent);
    });
  }

  async markEventPublished(tenantId: string, eventId: string): Promise<void> {
    const context: AppContext = {
      tenantId,
      userId: tenantId,
      roles: ['system'],
      requestId: 'outbox-publisher',
    };
    await this.withTenant(context, async (client) => {
      await client.query(
        `
        UPDATE domain_events
        SET published_at = COALESCE(published_at, now())
        WHERE tenant_id = $1 AND id = $2
      `,
        [tenantId, eventId],
      );
    });
  }

  async quarantineEvent(tenantId: string, eventId: string, reason: string): Promise<void> {
    const context: AppContext = {
      tenantId,
      userId: tenantId,
      roles: ['system'],
      requestId: 'outbox-quarantine',
    };
    await this.withTenant(context, async (client) => {
      const quarantined = await client.query(
        `
        UPDATE domain_events
        SET outbox_quarantined_at = COALESCE(outbox_quarantined_at, now()),
            outbox_error = $3
        WHERE tenant_id = $1 AND id = $2
        RETURNING id
      `,
        [tenantId, eventId, reason.slice(0, 4_000)],
      );
      if (!quarantined.rows[0]) {
        throw new NotFoundException({ code: 'EVENT_NOT_FOUND', message: 'Event not found' });
      }
    });
  }

  private async withTenant<T>(
    context: AppContext,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [context.tenantId]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [context.userId]);
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

  private async assertChannel(
    client: PoolClient,
    context: AppContext,
    channelId: string,
  ): Promise<ChannelAccessRow> {
    const result = await client.query<ChannelAccessRow>(
      `
      SELECT c.next_sequence
      FROM channels c
      JOIN memberships member
        ON member.tenant_id = c.tenant_id AND member.user_id = $2
      WHERE c.tenant_id = $1
        AND c.id = $3
        AND (c.kind = 'public' OR EXISTS (
          SELECT 1 FROM channel_memberships cm
          WHERE cm.tenant_id = c.tenant_id
            AND cm.channel_id = c.id
            AND cm.user_id = $2
        ))
    `,
      [context.tenantId, context.userId, channelId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ForbiddenException('Channel access denied');
    }
    return row;
  }

  private async loadAccessibleMessage(
    client: PoolClient,
    context: AppContext,
    messageId: string,
    lock: boolean,
  ): Promise<MessageRow> {
    const result = await client.query<MessageRow>(
      `
      SELECT ${MESSAGE_PROJECTION}, member.role AS membership_role
      FROM messages m
      JOIN users u ON u.id = m.author_id
      JOIN channels c ON c.tenant_id = m.tenant_id AND c.id = m.channel_id
      JOIN memberships member
        ON member.tenant_id = m.tenant_id AND member.user_id = $2
      WHERE m.tenant_id = $1
        AND m.id = $3
        AND (c.kind = 'public' OR EXISTS (
          SELECT 1 FROM channel_memberships cm
          WHERE cm.tenant_id = c.tenant_id
            AND cm.channel_id = c.id
            AND cm.user_id = $2
        ))
      ${lock ? 'FOR UPDATE OF m' : ''}
    `,
      [context.tenantId, context.userId, messageId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found' });
    }
    return row;
  }

  private async loadMessage(
    client: PoolClient,
    tenantId: string,
    messageId: string,
  ): Promise<MessageRow | undefined> {
    const result = await client.query<MessageRow>(
      `
      SELECT ${MESSAGE_PROJECTION}
      FROM messages m
      JOIN users u ON u.id = m.author_id
      WHERE m.tenant_id = $1 AND m.id = $2
    `,
      [tenantId, messageId],
    );
    return result.rows[0];
  }

  private async snapshotRevision(
    client: PoolClient,
    context: AppContext,
    current: MessageRow,
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO message_revisions (
        tenant_id, message_id, revision, blocks, edited_by
      ) VALUES ($1, $2, $3, $4::jsonb, $5)
    `,
      [
        context.tenantId,
        current.id,
        current.revision,
        JSON.stringify(current.blocks),
        context.userId,
      ],
    );
  }

  private async sanitizeDeletedMessageHistory(
    client: PoolClient,
    context: AppContext,
    tombstone: Message,
  ): Promise<void> {
    const serialized = JSON.stringify(tombstone);
    await client.query(
      `
      UPDATE domain_events
      SET payload = jsonb_set(payload, '{message}', $3::jsonb, false)
      WHERE tenant_id = $1 AND payload #>> '{message,id}' = $2
    `,
      [context.tenantId, tombstone.id, serialized],
    );
    await client.query(
      `
      UPDATE domain_events
      SET payload = jsonb_set(payload, '{threadRoot}', $3::jsonb, false)
      WHERE tenant_id = $1 AND payload #>> '{threadRoot,id}' = $2
    `,
      [context.tenantId, tombstone.id, serialized],
    );
    await client.query(
      `
      UPDATE idempotency_keys
      SET response = jsonb_set(response, '{message}', $3::jsonb, false)
      WHERE tenant_id = $1 AND response #>> '{message,id}' = $2
    `,
      [context.tenantId, tombstone.id, serialized],
    );
    await client.query(
      `
      UPDATE idempotency_keys
      SET response = jsonb_set(response, '{event,payload,message}', $3::jsonb, false)
      WHERE tenant_id = $1 AND response #>> '{event,payload,message,id}' = $2
    `,
      [context.tenantId, tombstone.id, serialized],
    );
    await client.query(
      `
      UPDATE idempotency_keys
      SET response = jsonb_set(response, '{event,payload,threadRoot}', $3::jsonb, false)
      WHERE tenant_id = $1 AND response #>> '{event,payload,threadRoot,id}' = $2
    `,
      [context.tenantId, tombstone.id, serialized],
    );
  }

  private async getIdempotentResponse<T>(
    client: PoolClient,
    context: AppContext,
    scope: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<T | null> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${context.tenantId}:${context.userId}:${scope}:${idempotencyKey}`,
    ]);
    const cached = await client.query<CachedResponseRow>(
      `
      SELECT request_hash, response
      FROM idempotency_keys
      WHERE tenant_id = $1
        AND user_id = $2
        AND scope = $3
        AND idempotency_key = $4
    `,
      [context.tenantId, context.userId, scope, idempotencyKey],
    );
    const row = cached.rows[0];
    if (!row) return null;
    if (row.request_hash !== null && row.request_hash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency-Key was already used with a different request',
      });
    }
    if (row.request_hash === null) {
      await client.query(
        `
        UPDATE idempotency_keys
        SET request_hash = $5
        WHERE tenant_id = $1
          AND user_id = $2
          AND scope = $3
          AND idempotency_key = $4
          AND request_hash IS NULL
      `,
        [context.tenantId, context.userId, scope, idempotencyKey, requestHash],
      );
    }
    return row.response as T;
  }

  private async saveIdempotentResponse(
    client: PoolClient,
    context: AppContext,
    scope: string,
    idempotencyKey: string,
    requestHash: string,
    response: unknown,
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO idempotency_keys (
        tenant_id, user_id, scope, idempotency_key, request_hash, response
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
      [
        context.tenantId,
        context.userId,
        scope,
        idempotencyKey,
        requestHash,
        JSON.stringify(response),
      ],
    );
  }

  private assertMutable(message: MessageRow): void {
    if (message.deleted_at) {
      throw new ConflictException({
        code: 'MESSAGE_DELETED',
        message: 'Deleted messages cannot be changed',
      });
    }
  }

  private assertRevision(current: number, expected: number): void {
    if (current !== expected) this.throwRevisionConflict(expected, current);
  }

  private throwRevisionConflict(expected?: number, current?: number): never {
    throw new ConflictException({
      code: 'MESSAGE_REVISION_CONFLICT',
      message:
        expected === undefined || current === undefined
          ? 'Message was changed by another request'
          : `Expected revision ${expected}, current revision is ${current}`,
    });
  }

  private async audience(
    client: PoolClient,
    tenantId: string,
    channelId: string,
  ): Promise<string[]> {
    const result = await client.query(
      `
      SELECT member.user_id
      FROM channels c
      JOIN memberships member ON member.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1
        AND c.id = $2
        AND (c.kind = 'public' OR EXISTS (
          SELECT 1 FROM channel_memberships cm
          WHERE cm.tenant_id = c.tenant_id
            AND cm.channel_id = c.id
            AND cm.user_id = member.user_id
        ))
      ORDER BY member.user_id
    `,
      [tenantId, channelId],
    );
    return result.rows.map((row) => row.user_id);
  }

  private async insertEvent(
    client: PoolClient,
    context: AppContext,
    channelId: string,
    type: DomainEvent['type'],
    audience: string[],
    payload: Record<string, unknown>,
  ): Promise<DomainEvent> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `domain-events:${context.tenantId}`,
    ]);
    const id = randomUUID();
    const result = await client.query(
      `
      INSERT INTO domain_events (
        id, tenant_id, channel_id, audience_user_ids, event_type, payload
      ) VALUES ($1, $2, $3, $4::uuid[], $5, $6::jsonb)
      RETURNING
        cursor, id, tenant_id, channel_id, audience_user_ids, event_type,
        event_version, payload, occurred_at
    `,
      [id, context.tenantId, channelId, audience, type, JSON.stringify(payload)],
    );
    const event = toEvent(result.rows[0]);
    if (new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_DOMAIN_EVENT_JSON_BYTES) {
      throw new PayloadTooLargeException({
        code: 'EVENT_TOO_LARGE',
        message: `Domain event must not exceed ${MAX_DOMAIN_EVENT_JSON_BYTES} UTF-8 JSON bytes`,
      });
    }
    return event;
  }

  private async audit(
    client: PoolClient,
    context: AppContext,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO audit_events (
        tenant_id, actor_id, action, target_type, target_id, metadata, request_id
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `,
      [
        context.tenantId,
        context.userId,
        action,
        targetType,
        targetId,
        JSON.stringify(metadata),
        context.requestId,
      ],
    );
  }
}

function toMessage(row: MessageRow): Message {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    channelId: row.channel_id,
    threadRootId: row.thread_root_id,
    sequence: Number(row.sequence),
    author: {
      id: row.author_id,
      displayName: row.display_name,
      email: row.email,
      avatarUrl: row.avatar_url,
      status: 'offline',
    },
    blocks: deleted ? [] : row.blocks,
    revision: row.revision,
    replyCount: Number(row.reply_count),
    reactions: deleted ? {} : (row.reactions ?? {}),
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
    channelId: row.channel_id ?? null,
    audienceUserIds: row.audience_user_ids,
    type: row.event_type,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
  };
}

function hashRequest(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot hash a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Cannot hash request value of type ${typeof value}`);
}
