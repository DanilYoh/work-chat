import { ConfigService } from '@nestjs/config';
import { MAX_DOMAIN_EVENT_JSON_BYTES, type DomainEvent } from '@work-chat/contracts';
import { describe, expect, it } from 'vitest';
import { EventPublisher } from '../src/events/event-publisher.js';
import type { Store } from '../src/store/store.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const channelId = '44444444-4444-4444-8444-444444444445';

function event(id: string, cursor: number): DomainEvent {
  return {
    id,
    cursor,
    version: 1,
    tenantId,
    channelId,
    audienceUserIds: ['22222222-2222-4222-8222-222222222222'],
    type: 'message.created',
    occurredAt: new Date().toISOString(),
    payload: {},
  };
}

function harness(events: DomainEvent[], failFirst = false) {
  const publishedIds: string[] = [];
  const markedIds = new Set<string>();
  const quarantinedIds = new Map<string, string>();
  let shouldFail = failFirst;
  const store = {
    async recoverUnpublishedEvents(_limit: number, requestedTenantId?: string) {
      return events.filter(
        (candidate) =>
          !markedIds.has(candidate.id) &&
          !quarantinedIds.has(candidate.id) &&
          (!requestedTenantId || candidate.tenantId === requestedTenantId),
      );
    },
    async markEventPublished(_tenantId: string, eventId: string) {
      markedIds.add(eventId);
    },
    async quarantineEvent(_tenantId: string, eventId: string, reason: string) {
      quarantinedIds.set(eventId, reason);
    },
  } as unknown as Store;
  const publisher = new EventPublisher(new ConfigService({ NATS_URL: 'nats://unused' }), store);
  const internals = publisher as unknown as {
    connection: { isClosed(): boolean };
    jetstream: {
      publish(subject: string, data: Uint8Array, options: { msgID: string }): Promise<void>;
    };
  };
  internals.connection = { isClosed: () => false };
  internals.jetstream = {
    async publish(_subject, _data, options) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('temporary NATS failure');
      }
      publishedIds.push(options.msgID);
    },
  };
  return { publisher, publishedIds, markedIds, quarantinedIds };
}

describe('EventPublisher ordered outbox', () => {
  it('publishes older tenant events before the mutation that triggered recovery', async () => {
    const older = event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1);
    const current = event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2);
    const { publisher, publishedIds, markedIds } = harness([older, current]);

    await publisher.publish(current);

    expect(publishedIds).toEqual([older.id, current.id]);
    expect([...markedIds]).toEqual([older.id, current.id]);
  });

  it('stops on a failed event and retries it before later events', async () => {
    const older = event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1);
    const current = event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2);
    const { publisher, publishedIds, markedIds } = harness([older, current], true);

    await publisher.publish(current);
    expect(publishedIds).toEqual([]);
    expect(markedIds.size).toBe(0);

    await publisher.publish(current);
    expect(publishedIds).toEqual([older.id, current.id]);
  });

  it('quarantines an oversized legacy event and continues the tenant outbox', async () => {
    const oversized = {
      ...event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1),
      payload: { legacyContent: 'x'.repeat(MAX_DOMAIN_EVENT_JSON_BYTES) },
    };
    const current = event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2);
    const { publisher, publishedIds, markedIds, quarantinedIds } = harness([oversized, current]);

    await publisher.publish(current);

    expect([...quarantinedIds.keys()]).toEqual([oversized.id]);
    expect(publishedIds).toEqual([current.id]);
    expect([...markedIds]).toEqual([current.id]);
  });
});
