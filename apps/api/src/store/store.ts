import type {
  BootstrapResponse,
  CreateMessageInput,
  CreateWorkItemInput,
  CursorPage,
  DomainEvent,
  Message,
  WorkItem,
} from '@work-chat/contracts';
import type { AppContext } from '../common/context.js';

export const STORE = Symbol('STORE');

export interface Store {
  bootstrap(context: AppContext): Promise<BootstrapResponse>;
  listMessages(context: AppContext, channelId: string, afterSequence: number, limit: number): Promise<CursorPage<Message>>;
  createMessage(context: AppContext, channelId: string, idempotencyKey: string, input: CreateMessageInput): Promise<{ message: Message; event: DomainEvent; reused: boolean }>;
  createWorkItem(context: AppContext, messageId: string, input: CreateWorkItemInput): Promise<{ item: WorkItem; event: DomainEvent }>;
  listWorkItems(context: AppContext, channelId?: string): Promise<WorkItem[]>;
  sync(context: AppContext, afterCursor: number, limit: number): Promise<CursorPage<DomainEvent>>;
  recoverUnpublishedEvents(limit: number): Promise<DomainEvent[]>;
  markEventPublished(tenantId: string, eventId: string): Promise<void>;
}
