import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RealtimeGateway } from '../src/gateway.js';

process.env.AUTH_MODE = 'dev';
process.env.DEV_TENANT_ID = '11111111-1111-4111-8111-111111111111';
process.env.DEV_USER_ID = '22222222-2222-4222-8222-222222222222';
delete process.env.NATS_URL;

describe('realtime authorization', () => {
  const gateways: RealtimeGateway[] = [];
  afterEach(async () => Promise.all(gateways.map((gateway) => gateway.stop())));

  it('sends a ready frame after a successful upgrade', async () => {
    const gateway = new RealtimeGateway();
    gateways.push(gateway);
    await gateway.start(0);
    const address = gateway.address();
    const frame = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/events`);
      socket.once('message', (data) => { resolve(data.toString()); socket.close(); });
      socket.once('error', reject);
    });
    expect(JSON.parse(frame)).toMatchObject({ type: 'ready', version: 1 });
  });
});
