import { describe, expect, it } from 'vitest';
import { createMessageSchema, workItemSchema } from './index.js';

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
});
