import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAX_DOMAIN_EVENT_JSON_BYTES, type DomainEvent } from '@work-chat/contracts';
import { connect, JSONCodec, StorageType, type JetStreamClient, type NatsConnection } from 'nats';
import { STORE, type Store } from '../store/store.js';

const MIN_NATS_MAX_PAYLOAD_BYTES = Math.ceil(MAX_DOMAIN_EVENT_JSON_BYTES / 0.9);

@Injectable()
export class EventPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventPublisher.name);
  private readonly codec = JSONCodec<DomainEvent>();
  private connection: NatsConnection | undefined;
  private jetstream: JetStreamClient | undefined;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recovering = false;
  private connecting: Promise<boolean> | undefined;
  private stopping = false;
  private unavailableLogged = false;

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
    await this.ensureConnected(servers);
    await this.recoverOutbox();
    this.recoveryTimer = setInterval(() => {
      void this.recoveryTick(servers);
    }, 2_000);
  }

  async publish(event: DomainEvent): Promise<void> {
    const servers = this.config.get<string>('NATS_URL');
    if (!servers || !(await this.ensureConnected(servers))) return;
    // Never bypass older rows from the same tenant. This keeps JetStream order
    // aligned with the transactional event log after an outage.
    await this.recoverOutbox(event.tenantId);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.connecting;
    await this.connection?.drain();
  }

  private async recoveryTick(servers: string): Promise<void> {
    if (!(await this.ensureConnected(servers))) return;
    await this.recoverOutbox();
  }

  private async ensureConnected(servers: string): Promise<boolean> {
    if (this.jetstream && this.connection && !this.connection.isClosed()) return true;
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection(servers).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openConnection(servers: string): Promise<boolean> {
    let connection: NatsConnection | undefined;
    try {
      connection = await connect({ servers, timeout: 1_500, name: 'work-chat-api' });
      const serverMaxPayload = connection.info?.max_payload;
      if (serverMaxPayload && serverMaxPayload < MIN_NATS_MAX_PAYLOAD_BYTES) {
        if (!this.unavailableLogged) {
          this.logger.error(
            `NATS max_payload is ${serverMaxPayload}; at least ${MIN_NATS_MAX_PAYLOAD_BYTES} bytes are required`,
          );
          this.unavailableLogged = true;
        }
        await connection.close();
        return false;
      }
      const manager = await connection.jetstreamManager();
      try {
        await manager.streams.info('WORKCHAT_EVENTS');
      } catch {
        try {
          await manager.streams.add({
            name: 'WORKCHAT_EVENTS',
            subjects: ['workchat.events.*'],
            storage: StorageType.File,
            max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
            duplicate_window: 2 * 60 * 1_000_000_000,
          });
        } catch {
          // Another API instance may have created the stream concurrently.
          await manager.streams.info('WORKCHAT_EVENTS');
        }
      }
      if (this.stopping) {
        await connection.drain();
        return false;
      }
      this.connection = connection;
      this.jetstream = connection.jetstream();
      this.unavailableLogged = false;
      this.logger.log('Connected to NATS');
      void connection.closed().then(() => {
        if (this.connection === connection) {
          this.connection = undefined;
          this.jetstream = undefined;
        }
      });
      return true;
    } catch {
      await connection?.close();
      if (!this.unavailableLogged) {
        this.logger.warn('NATS is unavailable; API continues with sync fallback and will retry');
        this.unavailableLogged = true;
      }
      return false;
    }
  }

  private async recoverOutbox(tenantId?: string): Promise<void> {
    if (!this.jetstream || this.recovering) return;
    this.recovering = true;
    try {
      for (let batch = 0; batch < 10; batch += 1) {
        const events = await this.store.recoverUnpublishedEvents(100, tenantId);
        if (events.length === 0) break;
        for (const event of events) {
          if (!(await this.publishOutboxEvent(event))) return;
        }
        if (events.length < 100) break;
      }
    } catch {
      this.logger.warn('Outbox recovery failed; it will be retried');
    } finally {
      this.recovering = false;
    }
  }

  private async publishOutboxEvent(event: DomainEvent): Promise<boolean> {
    if (!this.jetstream) return false;
    try {
      if (event.channelId === null) {
        await this.store.markEventPublished(event.tenantId, event.id);
        return true;
      }
      const encoded = this.codec.encode(event);
      if (encoded.byteLength > MAX_DOMAIN_EVENT_JSON_BYTES) {
        const reason = `Encoded event is ${encoded.byteLength} bytes; delivery limit is ${MAX_DOMAIN_EVENT_JSON_BYTES}`;
        await this.store.quarantineEvent(event.tenantId, event.id, reason);
        this.logger.error(`Event ${event.id} was quarantined: ${reason}`);
        return true;
      }
      await this.jetstream.publish(`workchat.events.${event.tenantId}`, encoded, {
        msgID: event.id,
      });
      await this.store.markEventPublished(event.tenantId, event.id);
      return true;
    } catch {
      this.logger.warn(`Event ${event.id} remains in the outbox and will be retried`);
      return false;
    }
  }
}
