import { Inject, Injectable } from '@nestjs/common';
import type { CreateMessageInput, CreateWorkItemInput } from '@work-chat/contracts';
import type { AppContext } from '../common/context.js';
import { decodeCursor } from '../common/cursor.js';
import { EventPublisher } from '../events/event-publisher.js';
import { STORE, type Store } from '../store/store.js';

@Injectable()
export class MessagingService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(EventPublisher) private readonly events: EventPublisher,
  ) {}

  bootstrap(context: AppContext) {
    return this.store.bootstrap(context);
  }

  listMessages(context: AppContext, channelId: string, cursor?: string, limit = 50) {
    return this.store.listMessages(context, channelId, decodeCursor(cursor), Math.min(Math.max(limit, 1), 100));
  }

  async createMessage(context: AppContext, channelId: string, idempotencyKey: string, input: CreateMessageInput) {
    const result = await this.store.createMessage(context, channelId, idempotencyKey, input);
    if (!result.reused) await this.events.publish(result.event);
    return result.message;
  }

  async createWorkItem(context: AppContext, messageId: string, input: CreateWorkItemInput) {
    const result = await this.store.createWorkItem(context, messageId, input);
    await this.events.publish(result.event);
    return result.item;
  }

  listWorkItems(context: AppContext, channelId?: string) {
    return this.store.listWorkItems(context, channelId);
  }

  sync(context: AppContext, cursor?: string, limit = 100) {
    return this.store.sync(context, decodeCursor(cursor), Math.min(Math.max(limit, 1), 500));
  }
}
