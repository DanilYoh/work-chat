import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BootstrapResponse,
  Channel,
  CreateMessageInput,
  CreateWorkItemInput,
  CursorPage,
  DomainEvent,
  Message,
  Space,
  User,
  WorkItem,
} from '@work-chat/contracts';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../common/context.js';
import { encodeCursor } from '../common/cursor.js';
import type { Store } from './store.js';

export const DEMO_IDS = {
  tenant: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  userTwo: '22222222-2222-4222-8222-222222222223',
  space: '33333333-3333-4333-8333-333333333333',
  channelGeneral: '44444444-4444-4444-8444-444444444444',
  channelBackend: '44444444-4444-4444-8444-444444444445',
  channelIncident: '44444444-4444-4444-8444-444444444446',
} as const;

@Injectable()
export class MemoryStore implements Store {
  private readonly users = new Map<string, User>();
  private readonly channels = new Map<string, Channel>();
  private readonly spaces: Space[];
  private readonly messages = new Map<string, Message[]>();
  private readonly workItems: WorkItem[] = [];
  private readonly events: DomainEvent[] = [];
  private readonly idempotency = new Map<string, Message>();
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
    this.users.set(danil.id, danil);
    this.users.set(marina.id, marina);
    const channels: Channel[] = [
      { id: DEMO_IDS.channelGeneral, spaceId: DEMO_IDS.space, name: 'Общий', slug: 'general', description: 'Главные объявления команды', kind: 'public', unreadCount: 0 },
      { id: DEMO_IDS.channelBackend, spaceId: DEMO_IDS.space, name: 'Backend', slug: 'backend', description: 'API, архитектура и code review', kind: 'public', unreadCount: 3 },
      { id: DEMO_IDS.channelIncident, spaceId: DEMO_IDS.space, name: 'Инциденты', slug: 'incidents', description: 'Оперативная работа с production-инцидентами', kind: 'private', unreadCount: 1 },
    ];
    channels.forEach((channel) => this.channels.set(channel.id, channel));
    this.spaces = [{ id: DEMO_IDS.space, name: 'Platform', slug: 'platform', channels }];
    const createdAt = new Date(Date.now() - 22 * 60_000).toISOString();
    const sample: Message = {
      id: '55555555-5555-4555-8555-555555555555',
      channelId: DEMO_IDS.channelBackend,
      threadRootId: null,
      sequence: 1,
      author: marina,
      blocks: [{ type: 'text', text: 'После релиза API p95 вырос до 780 мс. Проверяю запросы к истории сообщений.' }],
      revision: 1,
      replyCount: 2,
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
    this.assertTenant(context);
    const currentUser = this.users.get(context.userId);
    if (!currentUser) throw new ForbiddenException('User is not a member of this organization');
    return {
      organization: { id: DEMO_IDS.tenant, name: 'Orbit Labs', slug: 'orbit-labs' },
      currentUser,
      spaces: structuredClone(this.spaces),
      directMessages: [],
    };
  }

  async listMessages(context: AppContext, channelId: string, afterSequence: number, limit: number): Promise<CursorPage<Message>> {
    this.assertAccess(context, channelId);
    const items = (this.messages.get(channelId) ?? [])
      .filter((message) => message.sequence > afterSequence)
      .slice(0, limit);
    const last = items.at(-1);
    return { items: structuredClone(items), nextCursor: last ? encodeCursor(last.sequence) : null };
  }

  async createMessage(context: AppContext, channelId: string, idempotencyKey: string, input: CreateMessageInput): Promise<{ message: Message; event: DomainEvent; reused: boolean }> {
    this.assertAccess(context, channelId);
    const cacheKey = `${context.tenantId}:${context.userId}:${channelId}:${idempotencyKey}`;
    const existing = this.idempotency.get(cacheKey);
    if (existing) {
      const event = this.events.find((candidate) => candidate.payload.message && (candidate.payload.message as Message).id === existing.id);
      if (!event) throw new Error('Idempotency event is missing');
      return { message: structuredClone(existing), event: structuredClone(event), reused: true };
    }
    const author = this.users.get(context.userId);
    if (!author) throw new ForbiddenException('User is not a member');
    const list = this.messages.get(channelId) ?? [];
    const now = new Date().toISOString();
    const message: Message = {
      id: randomUUID(),
      channelId,
      threadRootId: input.threadRootId ?? null,
      sequence: (list.at(-1)?.sequence ?? 0) + 1,
      author,
      blocks: input.blocks,
      revision: 1,
      replyCount: 0,
      reactions: {},
      createdAt: now,
      editedAt: null,
      deletedAt: null,
    };
    list.push(message);
    this.messages.set(channelId, list);
    const event = this.appendEvent(context, 'message.created', { message });
    this.idempotency.set(cacheKey, message);
    return { message: structuredClone(message), event: structuredClone(event), reused: false };
  }

  async createWorkItem(context: AppContext, messageId: string, input: CreateWorkItemInput): Promise<{ item: WorkItem; event: DomainEvent }> {
    const source = [...this.messages.values()].flat().find((message) => message.id === messageId);
    if (!source) throw new NotFoundException('Source message not found');
    this.assertAccess(context, source.channelId);
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
    this.workItems.unshift(item);
    const event = this.appendEvent(context, 'work_item.created', { workItem: item });
    return { item: structuredClone(item), event: structuredClone(event) };
  }

  async listWorkItems(context: AppContext, channelId?: string): Promise<WorkItem[]> {
    this.assertTenant(context);
    if (channelId) this.assertAccess(context, channelId);
    return structuredClone(this.workItems.filter((item) => !channelId || item.channelId === channelId));
  }

  async sync(context: AppContext, afterCursor: number, limit: number): Promise<CursorPage<DomainEvent>> {
    this.assertTenant(context);
    const items = this.events
      .filter((event) => event.cursor > afterCursor && event.audienceUserIds.includes(context.userId))
      .slice(0, limit);
    const last = items.at(-1);
    return { items: structuredClone(items), nextCursor: last ? encodeCursor(last.cursor) : null };
  }

  async recoverUnpublishedEvents(): Promise<DomainEvent[]> {
    return [];
  }

  async markEventPublished(): Promise<void> {
    // Memory events are already available through sync and need no durable acknowledgement.
  }

  private appendEvent(context: AppContext, type: DomainEvent['type'], payload: Record<string, unknown>): DomainEvent {
    const event: DomainEvent = {
      id: randomUUID(),
      cursor: ++this.eventCursor,
      version: 1,
      tenantId: context.tenantId,
      audienceUserIds: [...this.users.keys()],
      type,
      occurredAt: new Date().toISOString(),
      payload,
    };
    this.events.push(event);
    return event;
  }

  private assertTenant(context: AppContext): void {
    if (context.tenantId !== DEMO_IDS.tenant) throw new ForbiddenException('Organization access denied');
  }

  private assertAccess(context: AppContext, channelId: string): void {
    this.assertTenant(context);
    if (!this.users.has(context.userId) || !this.channels.has(channelId)) {
      throw new ForbiddenException('Channel access denied');
    }
  }
}
