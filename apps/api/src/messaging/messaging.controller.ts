import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createMessageSchema, createWorkItemSchema } from '@work-chat/contracts';
import { CurrentContext, type AppContext } from '../common/context.js';
import { parseInput } from '../common/parse.js';
import { MessagingService } from './messaging.service.js';

@ApiTags('workspace')
@Controller('v1')
export class MessagingController {
  constructor(@Inject(MessagingService) private readonly messaging: MessagingService) {}

  @Get('bootstrap')
  @ApiOperation({ summary: 'Load the current organization and navigation tree' })
  bootstrap(@CurrentContext() context: AppContext) {
    return this.messaging.bootstrap(context);
  }

  @Get('channels/:channelId/messages')
  @ApiOperation({ summary: 'List channel messages using an opaque cursor' })
  listMessages(
    @CurrentContext() context: AppContext,
    @Param('channelId') channelId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messaging.listMessages(context, channelId, cursor, Number(limit ?? 50));
  }

  @Post('channels/:channelId/messages')
  @ApiOperation({ summary: 'Send an idempotent channel message' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  createMessage(
    @CurrentContext() context: AppContext,
    @Param('channelId') channelId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'A valid Idempotency-Key header is required' });
    }
    return this.messaging.createMessage(context, channelId, idempotencyKey, parseInput(createMessageSchema, body));
  }

  @Post('messages/:messageId/work-items')
  @ApiOperation({ summary: 'Promote a message to a structured work item' })
  createWorkItem(
    @CurrentContext() context: AppContext,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.messaging.createWorkItem(context, messageId, parseInput(createWorkItemSchema, body));
  }

  @Get('work-items')
  listWorkItems(@CurrentContext() context: AppContext, @Query('channelId') channelId?: string) {
    return this.messaging.listWorkItems(context, channelId);
  }

  @Get('sync')
  @ApiOperation({ summary: 'Recover events after reconnect or offline work' })
  sync(
    @CurrentContext() context: AppContext,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messaging.sync(context, cursor, Number(limit ?? 100));
  }
}
