import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard.js';
import { EventPublisher } from './events/event-publisher.js';
import { HealthController } from './health.controller.js';
import { MessagingController } from './messaging/messaging.controller.js';
import { MessagingService } from './messaging/messaging.service.js';
import { MemoryStore } from './store/memory.store.js';
import { PostgresStore } from './store/postgres.store.js';
import { STORE } from './store/store.js';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController, MessagingController],
  providers: [
    MessagingService,
    EventPublisher,
    MemoryStore,
    {
      provide: PostgresStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get('STORE_MODE', 'memory') === 'postgres' ? new PostgresStore(config) : null,
    },
    {
      provide: STORE,
      inject: [ConfigService, MemoryStore, PostgresStore],
      useFactory: (config: ConfigService, memory: MemoryStore, postgres: PostgresStore | null) =>
        config.get('STORE_MODE', 'memory') === 'postgres' ? postgres : memory,
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
