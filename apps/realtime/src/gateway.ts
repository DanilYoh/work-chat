import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { domainEventSchema, type DomainEvent } from '@work-chat/contracts';
import { connect, JSONCodec, type NatsConnection, type Subscription } from 'nats';
import WebSocket, { WebSocketServer } from 'ws';
import { authenticate, type SocketIdentity } from './auth.js';

interface AuthenticatedSocket extends WebSocket {
  identity?: SocketIdentity;
  isAlive?: boolean;
}

export class RealtimeGateway {
  private readonly server = createServer((request, response) => {
    if (request.url === '/health/live' || request.url === '/health/ready') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', nats: Boolean(this.nats) }));
      return;
    }
    response.writeHead(404).end();
  });
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly codec = JSONCodec<DomainEvent>();
  private nats?: NatsConnection;
  private subscription?: Subscription;
  private heartbeat?: NodeJS.Timeout;

  async start(port: number): Promise<void> {
    this.server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    this.sockets.on('connection', (socket: AuthenticatedSocket) => {
      socket.isAlive = true;
      socket.on('pong', () => { socket.isAlive = true; });
      socket.send(JSON.stringify({ type: 'ready', version: 1 }));
    });
    this.heartbeat = setInterval(() => this.checkConnections(), 30_000);
    await this.connectNats();
    await new Promise<void>((resolve) => this.server.listen(port, '0.0.0.0', resolve));
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.subscription?.unsubscribe();
    await this.nats?.drain();
    for (const client of this.sockets.clients) client.close(1001, 'Server shutdown');
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  address(): AddressInfo {
    return this.server.address() as AddressInfo;
  }

  broadcast(event: DomainEvent): void {
    const frame = JSON.stringify({ type: 'event', event });
    for (const client of this.sockets.clients as Set<AuthenticatedSocket>) {
      const identity = client.identity;
      if (
        client.readyState === WebSocket.OPEN &&
        identity?.tenantId === event.tenantId &&
        event.audienceUserIds.includes(identity.userId)
      ) {
        client.send(frame);
      }
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!request.url?.startsWith('/v1/events')) {
      socket.destroy();
      return;
    }
    const identity = await authenticate(request);
    if (!identity || !identity.tenantId || !identity.userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (client: AuthenticatedSocket) => {
      client.identity = identity;
      this.sockets.emit('connection', client, request);
    });
  }

  private async connectNats(): Promise<void> {
    if (!process.env.NATS_URL) return;
    try {
      this.nats = await connect({ servers: process.env.NATS_URL, name: 'work-chat-realtime', timeout: 1_500 });
      this.subscription = this.nats.subscribe('workchat.events.*');
      void (async () => {
        for await (const message of this.subscription!) {
          const parsed = domainEventSchema.safeParse(this.codec.decode(message.data));
          if (parsed.success) this.broadcast(parsed.data);
        }
      })();
    } catch {
      // The sync endpoint remains the recovery path when NATS is unavailable.
    }
  }

  private checkConnections(): void {
    for (const client of this.sockets.clients as Set<AuthenticatedSocket>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }
}
