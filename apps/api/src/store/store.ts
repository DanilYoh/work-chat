import type {
  BootstrapResponse,
  CreateMessageInput,
  CreateWorkItemInput,
  CursorPage,
  DeleteMessageInput,
  DomainEvent,
  Message,
  MessageThread,
  ReactionInput,
  ReadState,
  UpdateMessageInput,
  UpdateReadStateInput,
  WorkItem,
} from '@work-chat/contracts';
import type { AppContext } from '../common/context.js';

export const STORE = Symbol('STORE');

export interface Store {
  bootstrap(context: AppContext): Promise<BootstrapResponse>;
  listMessages(
    context: AppContext,
    channelId: string,
    afterSequence: number,
    limit: number,
  ): Promise<CursorPage<Message>>;
  getThread(
    context: AppContext,
    rootMessageId: string,
    afterSequence: number,
    limit: number,
  ): Promise<MessageThread>;
  createMessage(
    context: AppContext,
    channelId: string,
    idempotencyKey: string,
    input: CreateMessageInput,
  ): Promise<{ message: Message; event: DomainEvent; reused: boolean }>;
  updateMessage(
    context: AppContext,
    messageId: string,
    idempotencyKey: string,
    input: UpdateMessageInput,
  ): Promise<{ message: Message; event: DomainEvent; reused: boolean }>;
  deleteMessage(
    context: AppContext,
    messageId: string,
    idempotencyKey: string,
    input: DeleteMessageInput,
  ): Promise<{ message: Message; event: DomainEvent; reused: boolean }>;
  setReaction(
    context: AppContext,
    messageId: string,
    input: ReactionInput,
    present: boolean,
  ): Promise<{ message: Message; event: DomainEvent | null }>;
  updateReadState(
    context: AppContext,
    channelId: string,
    input: UpdateReadStateInput,
  ): Promise<{ readState: ReadState; event: DomainEvent | null }>;
  createWorkItem(
    context: AppContext,
    messageId: string,
    input: CreateWorkItemInput,
  ): Promise<{ item: WorkItem; event: DomainEvent }>;
  listWorkItems(context: AppContext, channelId?: string): Promise<WorkItem[]>;
  sync(context: AppContext, afterCursor: number, limit: number): Promise<CursorPage<DomainEvent>>;
  recoverUnpublishedEvents(limit: number, tenantId?: string): Promise<DomainEvent[]>;
  markEventPublished(tenantId: string, eventId: string): Promise<void>;
  quarantineEvent(tenantId: string, eventId: string, reason: string): Promise<void>;
}
