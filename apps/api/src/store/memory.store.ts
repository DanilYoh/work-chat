import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
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
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../common/context.js';
import { encodeCursor } from '../common/cursor.js';
import type { Store } from './store.js';

type MembershipRole = 'owner' | 'admin' | 'member';

interface CachedMessageMutation {
  fingerprint: string;
  message: Message;
  event: DomainEvent;
}

interface StoredReadState {
  lastReadSequence: number;
  updatedAt: string;
}

interface StoredMessageRevision {
  revision: number;
  blocks: MessageBlock[];
  editedBy: string;
  createdAt: string;
}

export const DEMO_IDS = {
  tenant: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  userTwo: '22222222-2222-4222-8222-222222222223',
  userRestricted: '22222222-2222-4222-8222-222222222224',
  space: '33333333-3333-4333-8333-333333333333',
  channelGeneral: '44444444-4444-4444-8444-444444444444',
  channelBackend: '44444444-4444-4444-8444-444444444445',
  channelIncident: '44444444-4444-4444-8444-444444444446',
} as const;

@Injectable()
export class MemoryStore implements Store {
  private readonly users = new Map<string, User>();
  private readonly memberships = new Map<string, MembershipRole>();
  private readonly channels = new Map<string, Channel>();
  private readonly channelMemberships = new Map<string, Set<string>>();
  private readonly spaces: Space[];
  private readonly messages = new Map<string, Message[]>();
  private readonly messageRevisions = new Map<string, StoredMessageRevision[]>();
  private readonly readStates = new Map<string, StoredReadState>();
  private readonly workItems: WorkItem[] = [];
  private readonly events: DomainEvent[] = [];
  private readonly publishedEventIds = new Set<string>();
  private readonly quarantinedEvents = new Map<string, string>();
  private readonly idempotency = new Map<string, CachedMessageMutation>();
  private eventCursor = 0;

  constructor() {
    const danil: User = {
      id: DEMO_IDS.user,
      displayName: 'Данил Соколов',
      email: 'danil@example.ru',
      avatarUrl: null,
      status: 'online',
    };
    const marina: User = {
      id: DEMO_IDS.userTwo,
      displayName: 'Марина Орлова',
      email: 'marina@example.ru',
      avatarUrl: null,
      status: 'online',
    };
    const restrictedMember: User = {
      id: DEMO_IDS.userRestricted,
      displayName: 'Private Channel Outsider',
      email: 'restricted@example.ru',
      avatarUrl: null,
      status: 'offline',
    };
    this.users.set(danil.id, danil);
    this.users.set(marina.id, marina);
    this.users.set(restrictedMember.id, restrictedMember);
    this.memberships.set(danil.id, 'owner');
    this.memberships.set(marina.id, 'member');
    this.memberships.set(restrictedMember.id, 'member');
    const channels: Channel[] = [
      {
        id: DEMO_IDS.channelGeneral,
        spaceId: DEMO_IDS.space,
        name: 'Общий',
        slug: 'general',
        description: 'Главные объявления команды',
        kind: 'public',
        latestSequence: 0,
        lastReadSequence: 0,
        unreadCount: 0,
      },
      {
        id: DEMO_IDS.channelBackend,
        spaceId: DEMO_IDS.space,
        name: 'Backend',
        slug: 'backend',
        description: 'API, архитектура и code review',
        kind: 'public',
        latestSequence: 1,
        lastReadSequence: 0,
        unreadCount: 1,
      },
      {
        id: DEMO_IDS.channelIncident,
        spaceId: DEMO_IDS.space,
        name: 'Инциденты',
        slug: 'incidents',
        description: 'Оперативная работа с production-инцидентами',
        kind: 'private',
        latestSequence: 0,
        lastReadSequence: 0,
        unreadCount: 0,
      },
    ];
    channels.forEach((channel) => this.channels.set(channel.id, channel));
    this.channelMemberships.set(DEMO_IDS.channelIncident, new Set([danil.id, marina.id]));
    this.spaces = [{ id: DEMO_IDS.space, name: 'Platform', slug: 'platform', channels }];
    const createdAt = new Date(Date.now() - 22 * 60_000).toISOString();
    const sample: Message = {
      id: '55555555-5555-4555-8555-555555555555',
      channelId: DEMO_IDS.channelBackend,
      threadRootId: null,
      sequence: 1,
      author: marina,
      blocks: [
        {
          type: 'text',
          text: 'После релиза API p95 вырос до 780 мс. Проверяю запросы к истории сообщений.',
        },
      ],
      revision: 1,
      replyCount: 0,
      reactions: { '👀': [danil.id] },
      createdAt,
      editedAt: null,
      deletedAt: null,
    };
    this.messages.set(DEMO_IDS.channelBackend, [sample]);
    this.messages.set(DEMO_IDS.channelGeneral, []);
    this.messages.set(DEMO_IDS.channelIncident, []);
  }

  async bootstrap(context: AppContext): Promise<BootstrapResponse> {
    this.assertTenantMembership(context);
    const currentUser = this.users.get(context.userId);
    if (!currentUser) throw new ForbiddenException('User is not a member of this organization');
    return {
      organization: { id: DEMO_IDS.tenant, name: 'Orbit Labs', slug: 'orbit-labs' },
      currentUser: structuredClone(currentUser),
      spaces: this.spaces.map((space) => ({
        ...structuredClone(space),
        channels: space.channels
          .filter((channel) => this.canAccessChannel(context.userId, channel))
          .map((channel) => this.channelForUser(context.userId, channel)),
      })),
      directMessages: [],
    };
  }

  async listMessages(
    context: AppContext,
    channelId: string,
    beforeSequence: number | null,
    limit: number,
  ): Promise<CursorPage<Message>> {
    this.assertAccess(context, channelId);
    const candidates = (this.messages.get(channelId) ?? []).filter(
      (message) =>
        message.threadRootId === null &&
        (beforeSequence === null || message.sequence < beforeSequence),
    );
    const hasMore = candidates.length > limit;
    const items = candidates.slice(-limit);
    const oldest = items[0];
    return {
      items: structuredClone(items),
      nextCursor: hasMore && oldest ? encodeCursor(oldest.sequence) : null,
    };
  }

  async getThread(
    context: AppContext,
    rootMessageId: string,
    afterSequence: number,
    limit: number,
  ): Promise<MessageThread> {
    const root = this.requireMessage(context, rootMessageId);
    if (root.threadRootId !== null) {
      throw new BadRequestException({
        code: 'THREAD_ROOT_REQUIRED',
        message: 'A thread must be loaded by its root message',
      });
    }
    const replies = (this.messages.get(root.channelId) ?? [])
      .filter((message) => message.threadRootId === root.id && message.sequence > afterSequence)
      .slice(0, limit);
    const last = replies.at(-1);
    return {
      root: structuredClone(root),
      replies: structuredClone(replies),
      nextCursor: last ? encodeCursor(last.sequence) : null,
    };
  }

  async createMessage(
    context: AppContext,
    channelId: string,
    idempotencyKey: string,
    input: CreateMessageInput,
  ): Promise<{ message: Message; event: DomainEvent; reused: boolean }> {
    this.assertAccess(context, channelId);
    const cacheKey = this.idempotencyKey(
      context,
      `channel:${channelId}:message.create`,
      idempotencyKey,
    );
    const fingerprint = this.fingerprint(input);
    const reused = this.reuseMutation(cacheKey, fingerprint);
    if (reused) return reused;

    const threadRoot = input.threadRootId
      ? this.validateThreadRoot(channelId, input.threadRootId)
      : null;
    const author = this.users.get(context.userId);
    if (!author) throw new ForbiddenException('User is not a member');
    const list = this.messages.get(channelId) ?? [];
    const channel = this.channels.get(channelId)!;
    const now = new Date().toISOString();
    const message: Message = {
      id: randomUUID(),
      channelId,
      threadRootId: threadRoot?.id ?? null,
      sequence: channel.latestSequence + 1,
      author: structuredClone(author),
      blocks: structuredClone(input.blocks),
      revision: 1,
      replyCount: 0,
      reactions: {},
      createdAt: now,
      editedAt: null,
      deletedAt: null,
    };
    const nextThreadRoot = threadRoot
      ? { ...structuredClone(threadRoot), replyCount: threadRoot.replyCount + 1 }
      : null;
    const event = this.prepareEvent(
      context,
      'message.created',
      { message, threadRoot: nextThreadRoot },
      this.audienceForChannel(channelId),
    );
    list.push(message);
    this.messages.set(channelId, list);
    channel.latestSequence = message.sequence;
    if (threadRoot && nextThreadRoot) threadRoot.replyCount = nextThreadRoot.replyCount;
    this.commitEvent(event);
    this.cacheMutation(cacheKey, fingerprint, message, event);
    return { message: structuredClone(message), event: structuredClone(event), reused: false };
  }

  async updateMessage(
    context: AppContext,
    messageId: string,
    idempotencyKey: string,
    input: UpdateMessageInput,
  ): Promise<{ message: Message; event: DomainEvent; reused: boolean }> {
    const message = this.requireMessage(context, messageId);
    if (message.author.id !== context.userId) {
      throw new ForbiddenException({
        code: 'MESSAGE_EDIT_FORBIDDEN',
        message: 'Only the author can edit this message',
      });
    }
    const cacheKey = this.idempotencyKey(context, `message:${messageId}:update`, idempotencyKey);
    const fingerprint = this.fingerprint(input);
    const reused = this.reuseMutation(cacheKey, fingerprint);
    if (reused) return reused;
    if (message.deletedAt) {
      throw new ConflictException({
        code: 'MESSAGE_DELETED',
        message: 'Deleted messages cannot be edited',
      });
    }
    this.assertRevision(message, input.expectedRevision);
    const now = new Date().toISOString();
    const nextMessage: Message = {
      ...structuredClone(message),
      blocks: structuredClone(input.blocks),
      revision: message.revision + 1,
      editedAt: now,
    };
    const event = this.prepareEvent(
      context,
      'message.updated',
      { message: nextMessage },
      this.audienceForChannel(message.channelId),
    );
    this.saveRevision(message, context.userId, now);
    message.blocks = nextMessage.blocks;
    message.revision = nextMessage.revision;
    message.editedAt = nextMessage.editedAt;
    this.commitEvent(event);
    this.cacheMutation(cacheKey, fingerprint, message, event);
    return { message: structuredClone(message), event: structuredClone(event), reused: false };
  }

  async deleteMessage(
    context: AppContext,
    messageId: string,
    idempotencyKey: string,
    input: DeleteMessageInput,
  ): Promise<{ message: Message; event: DomainEvent; reused: boolean }> {
    const message = this.requireMessage(context, messageId);
    const role = this.memberships.get(context.userId);
    if (message.author.id !== context.userId && role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException({
        code: 'MESSAGE_DELETE_FORBIDDEN',
        message: 'Only the author or an organization administrator can delete this message',
      });
    }
    const cacheKey = this.idempotencyKey(context, `message:${messageId}:delete`, idempotencyKey);
    const fingerprint = this.fingerprint(input);
    const reused = this.reuseMutation(cacheKey, fingerprint);
    if (reused) return reused;
    if (message.deletedAt) {
      throw new ConflictException({
        code: 'MESSAGE_DELETED',
        message: 'Message is already deleted',
      });
    }
    this.assertRevision(message, input.expectedRevision);
    const now = new Date().toISOString();
    const tombstone: Message = {
      ...structuredClone(message),
      blocks: [],
      reactions: {},
      revision: message.revision + 1,
      deletedAt: now,
    };
    const event = this.prepareEvent(
      context,
      'message.deleted',
      { message: tombstone },
      this.audienceForChannel(message.channelId),
    );
    this.saveRevision(message, context.userId, now);
    message.blocks = tombstone.blocks;
    message.reactions = tombstone.reactions;
    message.revision = tombstone.revision;
    message.deletedAt = tombstone.deletedAt;
    this.sanitizeDeletedMessageHistory(message);
    this.commitEvent(event);
    this.cacheMutation(cacheKey, fingerprint, message, event);
    return { message: structuredClone(message), event: structuredClone(event), reused: false };
  }

  async setReaction(
    context: AppContext,
    messageId: string,
    input: ReactionInput,
    present: boolean,
  ): Promise<{ message: Message; event: DomainEvent | null }> {
    const message = this.requireMessage(context, messageId);
    if (message.deletedAt) {
      throw new ConflictException({
        code: 'MESSAGE_DELETED',
        message: 'Deleted messages cannot be reacted to',
      });
    }
    const userIds = new Set(message.reactions[input.emoji] ?? []);
    const alreadyPresent = userIds.has(context.userId);
    if (alreadyPresent === present) return { message: structuredClone(message), event: null };
    if (present && this.reactionMembershipCount(message) >= MAX_MESSAGE_REACTION_MEMBERSHIPS) {
      throw new BadRequestException({
        code: 'REACTION_LIMIT_REACHED',
        message: `A message cannot have more than ${MAX_MESSAGE_REACTION_MEMBERSHIPS} reaction memberships`,
      });
    }
    if (present) userIds.add(context.userId);
    else userIds.delete(context.userId);
    const nextMessage = structuredClone(message);
    if (userIds.size > 0) nextMessage.reactions[input.emoji] = [...userIds].sort();
    else delete nextMessage.reactions[input.emoji];
    const event = this.prepareEvent(
      context,
      present ? 'reaction.added' : 'reaction.removed',
      { message: nextMessage },
      this.audienceForChannel(message.channelId),
    );
    message.reactions = nextMessage.reactions;
    this.commitEvent(event);
    return { message: structuredClone(message), event: structuredClone(event) };
  }

  async updateReadState(
    context: AppContext,
    channelId: string,
    input: UpdateReadStateInput,
  ): Promise<{ readState: ReadState; event: DomainEvent | null }> {
    this.assertAccess(context, channelId);
    const channel = this.channels.get(channelId)!;
    if (input.lastReadSequence > channel.latestSequence) {
      throw new BadRequestException({
        code: 'READ_SEQUENCE_OUT_OF_RANGE',
        message: 'Read sequence is newer than the channel',
      });
    }
    const key = this.readStateKey(context.userId, channelId);
    const existing = this.readStates.get(key);
    if (existing && input.lastReadSequence <= existing.lastReadSequence) {
      return { readState: this.toReadState(context.userId, channelId, existing), event: null };
    }
    const stored: StoredReadState = {
      lastReadSequence: input.lastReadSequence,
      updatedAt: new Date().toISOString(),
    };
    const readState = this.toReadState(context.userId, channelId, stored);
    if (input.lastReadSequence === 0 && !existing) {
      this.readStates.set(key, stored);
      return { readState, event: null };
    }
    const event = this.prepareEvent(context, 'channel.read', { readState }, [context.userId]);
    this.readStates.set(key, stored);
    this.commitEvent(event);
    return { readState, event: structuredClone(event) };
  }

  async createWorkItem(
    context: AppContext,
    messageId: string,
    input: CreateWorkItemInput,
  ): Promise<{ item: WorkItem; event: DomainEvent }> {
    const source = this.requireMessage(context, messageId);
    if (source.deletedAt) {
      throw new ConflictException({
        code: 'MESSAGE_DELETED',
        message: 'Deleted messages cannot become work items',
      });
    }
    if (input.ownerId && !this.memberships.has(input.ownerId)) {
      throw new BadRequestException({
        code: 'INVALID_WORK_ITEM_OWNER',
        message: 'Work item owner must belong to the organization',
      });
    }
    const now = new Date().toISOString();
    const item: WorkItem = {
      id: randomUUID(),
      channelId: source.channelId,
      sourceMessageId: source.id,
      type: input.type,
      title: input.title,
      status: 'open',
      ownerId: input.ownerId ?? null,
      dueAt: input.dueAt ?? null,
      severity: input.type === 'incident' ? (input.severity ?? 'sev3') : null,
      externalReferences: input.externalReferences,
      createdAt: now,
      updatedAt: now,
    };
    const event = this.prepareEvent(
      context,
      'work_item.created',
      { workItem: item },
      this.audienceForChannel(source.channelId),
    );
    this.workItems.unshift(item);
    this.commitEvent(event);
    return { item: structuredClone(item), event: structuredClone(event) };
  }

  async listWorkItems(context: AppContext, channelId?: string): Promise<WorkItem[]> {
    this.assertTenantMembership(context);
    if (channelId) this.assertAccess(context, channelId);
    return structuredClone(
      this.workItems.filter((item) => {
        if (channelId) return item.channelId === channelId;
        const channel = this.channels.get(item.channelId);
        return Boolean(channel && this.canAccessChannel(context.userId, channel));
      }),
    );
  }

  async sync(
    context: AppContext,
    afterCursor: number,
    limit: number,
  ): Promise<CursorPage<DomainEvent>> {
    this.assertTenantMembership(context);
    const items = this.events
      .filter((event) => event.cursor > afterCursor && this.canReceiveEvent(context.userId, event))
      .slice(0, limit);
    const last = items.at(-1);
    return { items: structuredClone(items), nextCursor: last ? encodeCursor(last.cursor) : null };
  }

  async recoverUnpublishedEvents(limit: number, tenantId?: string): Promise<DomainEvent[]> {
    return structuredClone(
      this.events
        .filter(
          (event) =>
            !this.publishedEventIds.has(event.id) &&
            !this.quarantinedEvents.has(event.id) &&
            (tenantId === undefined || event.tenantId === tenantId),
        )
        .slice(0, limit),
    );
  }

  async markEventPublished(tenantId: string, eventId: string): Promise<void> {
    const event = this.events.find((candidate) => candidate.id === eventId);
    if (!event) {
      throw new NotFoundException({ code: 'EVENT_NOT_FOUND', message: 'Event not found' });
    }
    if (event.tenantId !== tenantId) {
      throw new ForbiddenException('Organization access denied');
    }
    this.publishedEventIds.add(eventId);
  }

  async quarantineEvent(tenantId: string, eventId: string, reason: string): Promise<void> {
    const event = this.events.find((candidate) => candidate.id === eventId);
    if (!event) {
      throw new NotFoundException({ code: 'EVENT_NOT_FOUND', message: 'Event not found' });
    }
    if (event.tenantId !== tenantId) {
      throw new ForbiddenException('Organization access denied');
    }
    this.quarantinedEvents.set(eventId, reason.slice(0, 4_000));
  }

  private prepareEvent(
    context: AppContext,
    type: DomainEvent['type'],
    payload: Record<string, unknown>,
    audienceUserIds: string[],
  ): DomainEvent {
    const event: DomainEvent = {
      id: randomUUID(),
      cursor: this.eventCursor + 1,
      version: 1,
      tenantId: context.tenantId,
      channelId: this.eventChannelId(payload),
      audienceUserIds: [...audienceUserIds],
      type,
      occurredAt: new Date().toISOString(),
      payload: structuredClone(payload),
    };
    if (new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_DOMAIN_EVENT_JSON_BYTES) {
      throw new PayloadTooLargeException({
        code: 'EVENT_TOO_LARGE',
        message: `Domain event must not exceed ${MAX_DOMAIN_EVENT_JSON_BYTES} UTF-8 JSON bytes`,
      });
    }
    return event;
  }

  private commitEvent(event: DomainEvent): void {
    this.eventCursor = event.cursor;
    this.events.push(event);
  }

  private findMessage(messageId: string): Message | undefined {
    return [...this.messages.values()].flat().find((message) => message.id === messageId);
  }

  private eventChannelId(payload: Record<string, unknown>): string {
    const message = payload.message as Message | undefined;
    const workItem = payload.workItem as WorkItem | undefined;
    const readState = payload.readState as ReadState | undefined;
    const channelId = message?.channelId ?? workItem?.channelId ?? readState?.channelId;
    if (!channelId) throw new Error('Channel-scoped event payload is missing channelId');
    return channelId;
  }

  private reactionMembershipCount(message: Message): number {
    return Object.values(message.reactions).reduce((total, userIds) => total + userIds.length, 0);
  }

  private sanitizeDeletedMessageHistory(tombstone: Message): void {
    for (const event of this.events) this.sanitizeEventMessage(event, tombstone);
    for (const cached of this.idempotency.values()) {
      if (cached.message.id === tombstone.id) cached.message = structuredClone(tombstone);
      this.sanitizeEventMessage(cached.event, tombstone);
    }
  }

  private sanitizeEventMessage(event: DomainEvent, tombstone: Message): void {
    for (const key of ['message', 'threadRoot'] as const) {
      const candidate = event.payload[key] as Message | null | undefined;
      if (candidate?.id === tombstone.id) event.payload[key] = structuredClone(tombstone);
    }
  }

  private requireMessage(context: AppContext, messageId: string): Message {
    this.assertTenantMembership(context);
    const message = this.findMessage(messageId);
    const channel = message ? this.channels.get(message.channelId) : undefined;
    if (!message || !channel || !this.canAccessChannel(context.userId, channel)) {
      throw new NotFoundException({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found' });
    }
    return message;
  }

  private validateThreadRoot(channelId: string, rootMessageId: string): Message {
    const root = this.findMessage(rootMessageId);
    if (
      !root ||
      root.channelId !== channelId ||
      root.threadRootId !== null ||
      root.deletedAt !== null
    ) {
      throw new BadRequestException({
        code: 'INVALID_THREAD_ROOT',
        message: 'Thread root must be an active top-level message in the same channel',
      });
    }
    return root;
  }

  private assertRevision(message: Message, expectedRevision: number): void {
    if (message.revision !== expectedRevision) {
      throw new ConflictException({
        code: 'MESSAGE_REVISION_CONFLICT',
        message: `Expected revision ${expectedRevision}, current revision is ${message.revision}`,
      });
    }
  }

  private saveRevision(message: Message, editedBy: string, createdAt: string): void {
    const revisions = this.messageRevisions.get(message.id) ?? [];
    revisions.push({
      revision: message.revision,
      blocks: structuredClone(message.blocks),
      editedBy,
      createdAt,
    });
    this.messageRevisions.set(message.id, revisions);
  }

  private idempotencyKey(context: AppContext, scope: string, idempotencyKey: string): string {
    return `${context.tenantId}:${context.userId}:${scope}:${idempotencyKey}`;
  }

  private fingerprint(input: unknown): string {
    return JSON.stringify(input);
  }

  private reuseMutation(
    cacheKey: string,
    fingerprint: string,
  ): { message: Message; event: DomainEvent; reused: true } | null {
    const cached = this.idempotency.get(cacheKey);
    if (!cached) return null;
    if (cached.fingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency-Key was already used with a different request',
      });
    }
    return {
      message: structuredClone(cached.message),
      event: structuredClone(cached.event),
      reused: true,
    };
  }

  private cacheMutation(
    cacheKey: string,
    fingerprint: string,
    message: Message,
    event: DomainEvent,
  ): void {
    this.idempotency.set(cacheKey, {
      fingerprint,
      message: structuredClone(message),
      event: structuredClone(event),
    });
  }

  private readStateKey(userId: string, channelId: string): string {
    return `${userId}:${channelId}`;
  }

  private toReadState(userId: string, channelId: string, state: StoredReadState): ReadState {
    return {
      channelId,
      lastReadSequence: state.lastReadSequence,
      unreadCount: this.unreadCount(userId, channelId, state.lastReadSequence),
      updatedAt: state.updatedAt,
    };
  }

  private unreadCount(userId: string, channelId: string, lastReadSequence: number): number {
    return (this.messages.get(channelId) ?? []).filter(
      (message) =>
        message.sequence > lastReadSequence &&
        message.deletedAt === null &&
        message.author.id !== userId,
    ).length;
  }

  private channelForUser(userId: string, channel: Channel): Channel {
    const lastReadSequence =
      this.readStates.get(this.readStateKey(userId, channel.id))?.lastReadSequence ?? 0;
    return {
      ...structuredClone(channel),
      latestSequence: channel.latestSequence,
      lastReadSequence,
      unreadCount: this.unreadCount(userId, channel.id, lastReadSequence),
    };
  }

  private canReceiveEvent(userId: string, event: DomainEvent): boolean {
    if (!event.audienceUserIds.includes(userId)) return false;
    const message = event.payload.message as Message | undefined;
    const workItem = event.payload.workItem as WorkItem | undefined;
    const readState = event.payload.readState as ReadState | undefined;
    const channelId =
      event.channelId ?? message?.channelId ?? workItem?.channelId ?? readState?.channelId;
    if (!channelId) return true;
    const channel = this.channels.get(channelId);
    return Boolean(channel && this.canAccessChannel(userId, channel));
  }

  private audienceForChannel(channelId: string): string[] {
    const channel = this.channels.get(channelId);
    if (!channel) return [];
    return [...this.memberships.keys()].filter((userId) => this.canAccessChannel(userId, channel));
  }

  private canAccessChannel(userId: string, channel: Channel): boolean {
    if (!this.memberships.has(userId)) return false;
    if (channel.kind === 'public') return true;
    return this.channelMemberships.get(channel.id)?.has(userId) ?? false;
  }

  private assertTenant(context: AppContext): void {
    if (context.tenantId !== DEMO_IDS.tenant)
      throw new ForbiddenException('Organization access denied');
  }

  private assertTenantMembership(context: AppContext): MembershipRole {
    this.assertTenant(context);
    const role = this.memberships.get(context.userId);
    if (!role) throw new ForbiddenException('User is not a member of this organization');
    return role;
  }

  private assertAccess(context: AppContext, channelId: string): void {
    this.assertTenantMembership(context);
    const channel = this.channels.get(channelId);
    if (!channel || !this.canAccessChannel(context.userId, channel)) {
      throw new ForbiddenException('Channel access denied');
    }
  }
}
