import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { DomainEvent } from '@work-chat/contracts';
import { RealtimeGateway } from '../src/gateway.js';
import type { AudienceAuthorizer } from '../src/channel-authorizer.js';

process.env.AUTH_MODE = 'dev';
process.env.DEV_TENANT_ID = '11111111-1111-4111-8111-111111111111';
process.env.DEV_USER_ID = '22222222-2222-4222-8222-222222222222';
delete process.env.NATS_URL;

describe('realtime authorization', () => {
  const gateways: RealtimeGateway[] = [];
  afterEach(async () => Promise.all(gateways.splice(0).map((gateway) => gateway.stop())));

  it('sends a ready frame after a successful upgrade', async () => {
    const gateway = new RealtimeGateway();
    gateways.push(gateway);
    await gateway.start(0);
    const address = gateway.address();
    const frame = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/events`);
      socket.once('message', (data) => {
        resolve(data.toString());
        socket.close();
      });
      socket.once('error', reject);
    });
    expect(JSON.parse(frame)).toMatchObject({ type: 'ready', version: 1 });
  });

  it('revalidates current channel access before sending a private event', async () => {
    let allowed = false;
    const audienceAuthorizer: AudienceAuthorizer = {
      async authorize(_event, userIds) {
        return new Set(allowed ? userIds : []);
      },
      async close() {},
    };
    const gateway = new RealtimeGateway({ audienceAuthorizer });
    gateways.push(gateway);
    await gateway.start(0);
    const address = gateway.address();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/events`);
    await new Promise<void>((resolve, reject) => {
      socket.once('message', () => resolve());
      socket.once('error', reject);
    });

    const event = (id: string): DomainEvent => ({
      id,
      cursor: 1,
      version: 1,
      tenantId: process.env.DEV_TENANT_ID!,
      channelId: '44444444-4444-4444-8444-444444444446',
      audienceUserIds: [process.env.DEV_USER_ID!],
      type: 'message.created',
      occurredAt: new Date().toISOString(),
      payload: {},
    });

    await gateway.broadcast(event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    allowed = true;
    const delivered = new Promise<string>((resolve) => {
      socket.once('message', (data) => resolve(data.toString()));
    });
    await gateway.broadcast(event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    expect(JSON.parse(await delivered).event.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    socket.close();
  });
});
