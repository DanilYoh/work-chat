import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  ready() {
    return { status: 'ready', store: process.env.STORE_MODE ?? 'memory' };
  }
}

