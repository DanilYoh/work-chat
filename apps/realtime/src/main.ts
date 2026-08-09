import { RealtimeGateway } from './gateway.js';

const gateway = new RealtimeGateway();
const port = Number(process.env.REALTIME_PORT ?? 3001);
await gateway.start(port);
console.log(`Realtime gateway listening on ws://localhost:${port}/v1/events`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void gateway.stop().finally(() => process.exit(0));
  });
}

