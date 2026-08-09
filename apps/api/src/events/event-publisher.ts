import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DomainEvent } from '@work-chat/contracts';
import { connect, JSONCodec, StorageType, type JetStreamClient, type NatsConnection } from 'nats';
import { STORE, type Store } from '../store/store.js';

@Injectable()
export class EventPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventPublisher.name);
  private readonly codec = JSONCodec<DomainEvent>();
  private connection?: NatsConnection;
  private jetstream?: JetStreamClient;
  private recoveryTimer?: NodeJS.Timeout;
  private recovering = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(STORE) private readonly store: Store,
  ) {}

  async onModuleInit(): Promise<void> {
    const servers = this.config.get<string>('NATS_URL');
    if (!servers) {
      this.logger.warn('NATS_URL is not set; realtime events are available through /v1/sync only');
      return;
    }
    try {
      this.connection = await connect({ servers, timeout: 1_500, name: 'work-chat-api' });
      const manager = await this.connection.jetstreamManager();
      try {
        await manager.streams.info('WORKCHAT_EVENTS');
      } catch {
        await manager.streams.add({
          name: 'WORKCHAT_EVENTS',
          subjects: ['workchat.events.*'],
          storage: StorageType.File,
          max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
          duplicate_window: 2 * 60 * 1_000_000_000,
        });
      }
      this.jetstream = this.connection.jetstream();
      this.logger.log('Connected to NATS');
      await this.recoverOutbox();
      this.recoveryTimer = setInterval(() => { void this.recoverOutbox(); }, 2_000);
    } catch {
      this.logger.warn('NATS is unavailable; API continues with sync fallback');
    }
  }

  async publish(event: DomainEvent): Promise<void> {
    if (!this.jetstream) return;
    await this.jetstream.publish(
      `workchat.events.${event.tenantId}`,
      this.codec.encode(event),
      { msgID: event.id },
    );
    await this.store.markEventPublished(event.tenantId, event.id);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.connection?.drain();
  }

  private async recoverOutbox(): Promise<void> {
    if (!this.jetstream || this.recovering) return;
    this.recovering = true;
    try {
      const events = await this.store.recoverUnpublishedEvents(100);
      for (const event of events) await this.publish(event);
    } catch {
      this.logger.warn('Outbox recovery failed; it will be retried');
    } finally {
      this.recovering = false;
    }
  }
}
