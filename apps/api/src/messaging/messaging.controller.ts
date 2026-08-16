import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createMessageSchema,
  createWorkItemSchema,
  deleteMessageSchema,
  identifierSchema,
  reactionSchema,
  updateMessageSchema,
  updateReadStateSchema,
} from '@work-chat/contracts';
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
    return this.messaging.listMessages(
      context,
      parseIdentifier(channelId),
      cursor,
      parseLimit(limit, 50),
    );
  }

  @Get('messages/:messageId/thread')
  @ApiOperation({ summary: 'Load a root message and its replies' })
  getThread(
    @CurrentContext() context: AppContext,
    @Param('messageId') messageId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messaging.getThread(
      context,
      parseIdentifier(messageId),
      cursor,
      parseLimit(limit, 50),
    );
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
    return this.messaging.createMessage(
      context,
      parseIdentifier(channelId),
      requireIdempotencyKey(idempotencyKey),
      parseInput(createMessageSchema, body),
    );
  }

  @Patch('messages/:messageId')
  @ApiOperation({ summary: 'Edit a message using optimistic revision locking' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  updateMessage(
    @CurrentContext() context: AppContext,
    @Param('messageId') messageId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.messaging.updateMessage(
      context,
      parseIdentifier(messageId),
      requireIdempotencyKey(idempotencyKey),
      parseInput(updateMessageSchema, body),
    );
  }

  @Delete('messages/:messageId')
  @ApiOperation({ summary: 'Soft-delete a message using optimistic revision locking' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  deleteMessage(
    @CurrentContext() context: AppContext,
    @Param('messageId') messageId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.messaging.deleteMessage(
      context,
      parseIdentifier(messageId),
      requireIdempotencyKey(idempotencyKey),
      parseInput(deleteMessageSchema, body),
    );
  }

  @Put('messages/:messageId/reactions')
  @ApiOperation({ summary: 'Add the current user reaction to a message' })
  addReaction(
    @CurrentContext() context: AppContext,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.messaging.setReaction(
      context,
      parseIdentifier(messageId),
      parseInput(reactionSchema, body),
      true,
    );
  }

  @Delete('messages/:messageId/reactions')
  @ApiOperation({ summary: 'Remove the current user reaction from a message' })
  removeReaction(
    @CurrentContext() context: AppContext,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.messaging.setReaction(
      context,
      parseIdentifier(messageId),
      parseInput(reactionSchema, body),
      false,
    );
  }

  @Put('channels/:channelId/read-state')
  @ApiOperation({ summary: 'Advance the current user channel read state' })
  updateReadState(
    @CurrentContext() context: AppContext,
    @Param('channelId') channelId: string,
    @Body() body: unknown,
  ) {
    return this.messaging.updateReadState(
      context,
      parseIdentifier(channelId),
      parseInput(updateReadStateSchema, body),
    );
  }

  @Post('messages/:messageId/work-items')
  @ApiOperation({ summary: 'Promote a message to a structured work item' })
  createWorkItem(
    @CurrentContext() context: AppContext,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.messaging.createWorkItem(
      context,
      parseIdentifier(messageId),
      parseInput(createWorkItemSchema, body),
    );
  }

  @Get('work-items')
  listWorkItems(@CurrentContext() context: AppContext, @Query('channelId') channelId?: string) {
    return this.messaging.listWorkItems(
      context,
      channelId ? parseIdentifier(channelId) : undefined,
    );
  }

  @Get('sync')
  @ApiOperation({ summary: 'Recover events after reconnect or offline work' })
  sync(
    @CurrentContext() context: AppContext,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messaging.sync(context, cursor, parseLimit(limit, 100));
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value || value.trim().length === 0 || value.length > 200) {
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'A valid Idempotency-Key header is required',
    });
  }
  return value;
}

function parseIdentifier(value: string): string {
  return parseInput(identifierSchema, value);
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      issues: [{ path: 'limit', message: 'Expected a positive integer' }],
    });
  }
  return parsed;
}
