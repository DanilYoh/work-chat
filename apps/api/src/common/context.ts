import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface AppContext {
  tenantId: string;
  userId: string;
  roles: string[];
  requestId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    appContext: AppContext;
  }
}

export const CurrentContext = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): AppContext => {
    const request = executionContext.switchToHttp().getRequest<FastifyRequest>();
    return request.appContext;
  },
);

