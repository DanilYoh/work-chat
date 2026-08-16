import { describe, expect, it } from 'vitest';
import {
  channelSchema,
  createMessageSchema,
  createWorkItemSchema,
  deleteMessageSchema,
  domainEventSchema,
  MAX_MESSAGE_BLOCKS_JSON_BYTES,
  messageSchema,
  messageThreadSchema,
  reactionSchema,
  readStateSchema,
  updateMessageSchema,
  updateReadStateSchema,
  workItemSchema,
} from './index.js';

const user = {
  id: '22222222-2222-4222-8222-222222222222',
  displayName: 'Danil',
  email: 'danil@example.ru',
  avatarUrl: null,
  status: 'online' as const,
};

const message = {
  id: '55555555-5555-4555-8555-555555555555',
  channelId: '44444444-4444-4444-8444-444444444444',
  threadRootId: null,
  sequence: 1,
  author: user,
  blocks: [{ type: 'text' as const, text: 'Ready for review' }],
  revision: 1,
  replyCount: 0,
  reactions: {},
  createdAt: '2026-08-09T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
};

describe('public contracts', () => {
  it('rejects an empty message', () => {
    const result = createMessageSchema.safeParse({
      clientId: '33333333-3333-4333-8333-333333333333',
      blocks: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a linked incident', () => {
    const result = workItemSchema.safeParse({
      id: '33333333-3333-4333-8333-333333333333',
      channelId: '44444444-4444-4444-8444-444444444444',
      sourceMessageId: '55555555-5555-4555-8555-555555555555',
      type: 'incident',
      title: 'API latency regression',
      status: 'open',
      ownerId: null,
      dueAt: null,
      severity: 'sev2',
      externalReferences: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a deleted message tombstone without blocks', () => {
    const result = messageSchema.safeParse({
      ...message,
      blocks: [],
      revision: 2,
      deletedAt: '2026-08-09T11:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('enforces active-message and tombstone block invariants', () => {
    expect(messageSchema.safeParse({ ...message, blocks: [] }).success).toBe(false);
    expect(
      messageSchema.safeParse({
        ...message,
        deletedAt: '2026-08-09T11:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('requires channel sequence and read-state counters', () => {
    const result = channelSchema.safeParse({
      id: message.channelId,
      spaceId: null,
      name: 'Backend',
      slug: 'backend',
      description: '',
      kind: 'public',
      latestSequence: 5,
      lastReadSequence: 3,
      unreadCount: 2,
    });
    expect(result.success).toBe(true);
  });

  it('validates optimistic message mutations', () => {
    expect(
      updateMessageSchema.safeParse({ blocks: message.blocks, expectedRevision: 1 }).success,
    ).toBe(true);
    expect(updateMessageSchema.safeParse({ blocks: [], expectedRevision: 1 }).success).toBe(false);
    expect(deleteMessageSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
  });

  it('bounds create and update blocks by their UTF-8 JSON size', () => {
    const acceptedBlocks = Array.from({ length: 5 }, () => ({
      type: 'code' as const,
      code: 'x'.repeat(50_000),
    }));
    const oversizedBlocks = [
      ...acceptedBlocks,
      {
        type: 'code' as const,
        code: 'x'.repeat(10_000),
      },
    ];
    expect(new TextEncoder().encode(JSON.stringify(acceptedBlocks)).byteLength).toBeLessThanOrEqual(
      MAX_MESSAGE_BLOCKS_JSON_BYTES,
    );
    expect(new TextEncoder().encode(JSON.stringify(oversizedBlocks)).byteLength).toBeGreaterThan(
      MAX_MESSAGE_BLOCKS_JSON_BYTES,
    );
    expect(
      createMessageSchema.safeParse({
        clientId: '33333333-3333-4333-8333-333333333333',
        blocks: acceptedBlocks,
      }).success,
    ).toBe(true);
    expect(
      createMessageSchema.safeParse({
        clientId: '33333333-3333-4333-8333-333333333333',
        blocks: oversizedBlocks,
      }).success,
    ).toBe(false);
    expect(
      updateMessageSchema.safeParse({
        expectedRevision: 1,
        blocks: oversizedBlocks,
      }).success,
    ).toBe(false);
  });

  it('normalizes and bounds reaction emoji', () => {
    expect(reactionSchema.parse({ emoji: '  \u{1F440}  ' })).toEqual({ emoji: '\u{1F440}' });
    expect(reactionSchema.safeParse({ emoji: '   ' }).success).toBe(false);
    expect(reactionSchema.safeParse({ emoji: 'x'.repeat(33) }).success).toBe(false);
  });

  it('bounds external reference identifiers and URLs', () => {
    const base = {
      type: 'action' as const,
      title: 'Track an external task',
      externalReferences: [
        {
          provider: 'other' as const,
          externalId: 'x',
          url: 'https://example.com/task',
        },
      ],
    };

    expect(createWorkItemSchema.safeParse(base).success).toBe(true);
    expect(
      createWorkItemSchema.safeParse({
        ...base,
        externalReferences: [{ ...base.externalReferences[0], externalId: 'x'.repeat(501) }],
      }).success,
    ).toBe(false);
    expect(
      createWorkItemSchema.safeParse({
        ...base,
        externalReferences: [
          {
            ...base.externalReferences[0],
            url: `https://example.com/${'x'.repeat(2_100)}`,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('validates safe monotonic read-state values', () => {
    expect(updateReadStateSchema.safeParse({ lastReadSequence: 0 }).success).toBe(true);
    expect(updateReadStateSchema.safeParse({ lastReadSequence: -1 }).success).toBe(false);
    expect(
      updateReadStateSchema.safeParse({ lastReadSequence: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
    expect(
      readStateSchema.safeParse({
        channelId: message.channelId,
        lastReadSequence: 1,
        unreadCount: 0,
        updatedAt: '2026-08-09T11:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('validates thread pages and interaction event types', () => {
    expect(
      messageThreadSchema.safeParse({ root: message, replies: [], nextCursor: null }).success,
    ).toBe(true);
    for (const type of ['reaction.added', 'reaction.removed', 'channel.read'] as const) {
      expect(
        domainEventSchema.safeParse({
          id: '66666666-6666-4666-8666-666666666666',
          cursor: 1,
          version: 1,
          tenantId: '11111111-1111-4111-8111-111111111111',
          channelId: message.channelId,
          audienceUserIds: [user.id],
          type,
          occurredAt: '2026-08-09T11:00:00.000Z',
          payload: {},
        }).success,
      ).toBe(true);
    }
  });

  it('defaults a legacy event without channelId to null', () => {
    const parsed = domainEventSchema.parse({
      id: '66666666-6666-4666-8666-666666666666',
      cursor: 1,
      version: 1,
      tenantId: '11111111-1111-4111-8111-111111111111',
      audienceUserIds: [user.id],
      type: 'message.created',
      occurredAt: '2026-08-09T11:00:00.000Z',
      payload: {},
    });

    expect(parsed.channelId).toBeNull();
  });
});
