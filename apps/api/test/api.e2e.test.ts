import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DEMO_IDS } from '../src/store/memory.store.js';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.DEV_TENANT_ID = DEMO_IDS.tenant;
process.env.DEV_USER_ID = DEMO_IDS.user;

describe('messaging vertical slice', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const { createApplication } = await import('../src/main.js');
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots an organization and lists a channel', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/bootstrap' });
    expect(response.statusCode).toBe(200);
    expect(response.json().spaces[0].channels).toHaveLength(3);
  });

  it('creates an idempotent message and exposes its event through sync', async () => {
    const payload = {
      clientId: '77777777-7777-4777-8777-777777777777',
      blocks: [{ type: 'text', text: 'Transactional outbox is ready for review.' }],
    };
    const first = await app.inject({
      method: 'POST',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages`,
      headers: { 'idempotency-key': 'e2e-message-1' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages`,
      headers: { 'idempotency-key': 'e2e-message-1' },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);

    const sync = await app.inject({ method: 'GET', url: '/v1/sync' });
    expect(sync.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message.created' })]),
    );
  });

  it('promotes a message to an incident', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages/55555555-5555-4555-8555-555555555555/work-items',
      payload: { type: 'incident', title: 'Investigate p95 latency', severity: 'sev2', externalReferences: [] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ type: 'incident', severity: 'sev2', status: 'open' });
  });

  it('rejects a request from another tenant with the standard error envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/bootstrap',
      headers: { 'x-tenant-id': '99999999-9999-4999-8999-999999999999' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'REQUEST_FAILED', message: 'Organization access denied' },
    });
    expect(response.json().error.requestId).toEqual(expect.any(String));
  });
});
