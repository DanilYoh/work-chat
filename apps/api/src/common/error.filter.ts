import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = exception instanceof HttpException ? exception.getResponse() : null;
    const details = typeof response === 'object' && response !== null ? response as Record<string, unknown> : {};
    const message = status >= 500
      ? 'Internal server error'
      : String(details.message ?? response ?? 'Request failed');
    const code = String(details.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'));

    void reply.status(status).send({
      error: {
        code,
        message,
        requestId: request.appContext?.requestId ?? request.id,
        ...(details.issues ? { issues: details.issues } : {}),
      },
    });
  }
}

