import { z } from 'zod';

export const identifierSchema = z.string().uuid();

export const channelKindSchema = z.enum(['public', 'private', 'dm', 'group_dm']);
export type ChannelKind = z.infer<typeof channelKindSchema>;

export const workItemTypeSchema = z.enum([
  'decision',
  'action',
  'incident',
  'release',
  'code_change',
]);
export type WorkItemType = z.infer<typeof workItemTypeSchema>;

export const workItemStatusSchema = z.enum(['open', 'in_progress', 'resolved', 'cancelled']);
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;

export const messageBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(20_000) }),
  z.object({
    type: z.literal('code'),
    code: z.string().min(1).max(50_000),
    language: z.string().max(64).optional(),
  }),
]);
export type MessageBlock = z.infer<typeof messageBlockSchema>;

export const MAX_MESSAGE_BLOCKS_JSON_BYTES = 256_000;
export const MAX_MESSAGE_REACTION_MEMBERSHIPS = 1_000;
export const MAX_DOMAIN_EVENT_JSON_BYTES = 900_000;

const messageInputBlocksSchema = z
  .array(messageBlockSchema)
  .min(1)
  .max(30)
  .superRefine((blocks, context) => {
    const bytes = new TextEncoder().encode(JSON.stringify(blocks)).byteLength;
    if (bytes > MAX_MESSAGE_BLOCKS_JSON_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Message blocks must not exceed ${MAX_MESSAGE_BLOCKS_JSON_BYTES} UTF-8 JSON bytes`,
      });
    }
  });

export const userSchema = z.object({
  id: identifierSchema,
  displayName: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().url().nullable(),
  status: z.enum(['online', 'away', 'offline']),
});
export type User = z.infer<typeof userSchema>;

export const channelSchema = z.object({
  id: identifierSchema,
  spaceId: identifierSchema.nullable(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  kind: channelKindSchema,
  latestSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastReadSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unreadCount: z.number().int().nonnegative(),
});
export type Channel = z.infer<typeof channelSchema>;

export const spaceSchema = z.object({
  id: identifierSchema,
  name: z.string(),
  slug: z.string(),
  channels: z.array(channelSchema),
});
export type Space = z.infer<typeof spaceSchema>;

export const messageSchema = z
  .object({
    id: identifierSchema,
    channelId: identifierSchema,
    threadRootId: identifierSchema.nullable(),
    sequence: z.number().int().positive(),
    author: userSchema,
    blocks: z.array(messageBlockSchema).max(30),
    revision: z.number().int().positive(),
    replyCount: z.number().int().nonnegative(),
    reactions: z.record(z.string(), z.array(identifierSchema)),
    createdAt: z.string().datetime(),
    editedAt: z.string().datetime().nullable(),
    deletedAt: z.string().datetime().nullable(),
  })
  .superRefine((message, context) => {
    if (message.deletedAt === null && message.blocks.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blocks'],
        message: 'Active messages must contain at least one block',
      });
    }
    if (message.deletedAt !== null && message.blocks.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blocks'],
        message: 'Deleted messages must not expose content blocks',
      });
    }
  });
export type Message = z.infer<typeof messageSchema>;

export const externalReferenceSchema = z.object({
  provider: z.enum(['github', 'gitlab', 'jira', 'youtrack', 'sentry', 'grafana', 'other']),
  externalId: z.string().max(500),
  url: z.string().url().max(2_048),
});
export type ExternalReference = z.infer<typeof externalReferenceSchema>;

export const workItemSchema = z.object({
  id: identifierSchema,
  channelId: identifierSchema,
  sourceMessageId: identifierSchema,
  type: workItemTypeSchema,
  title: z.string(),
  status: workItemStatusSchema,
  ownerId: identifierSchema.nullable(),
  dueAt: z.string().datetime().nullable(),
  severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']).nullable(),
  externalReferences: z.array(externalReferenceSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkItem = z.infer<typeof workItemSchema>;

export const bootstrapResponseSchema = z.object({
  organization: z.object({ id: identifierSchema, name: z.string(), slug: z.string() }),
  currentUser: userSchema,
  spaces: z.array(spaceSchema),
  directMessages: z.array(channelSchema),
});
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

export const createMessageSchema = z.object({
  clientId: identifierSchema,
  threadRootId: identifierSchema.nullable().optional(),
  blocks: messageInputBlocksSchema,
});
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const updateMessageSchema = z.object({
  blocks: messageInputBlocksSchema,
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type UpdateMessageInput = z.infer<typeof updateMessageSchema>;

export const deleteMessageSchema = z.object({
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type DeleteMessageInput = z.infer<typeof deleteMessageSchema>;

export const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(32),
});
export type ReactionInput = z.infer<typeof reactionSchema>;

export const updateReadStateSchema = z.object({
  lastReadSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type UpdateReadStateInput = z.infer<typeof updateReadStateSchema>;

export const readStateSchema = z.object({
  channelId: identifierSchema,
  lastReadSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unreadCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export type ReadState = z.infer<typeof readStateSchema>;

export const messageThreadSchema = z.object({
  root: messageSchema,
  replies: z.array(messageSchema),
  nextCursor: z.string().nullable(),
});
export type MessageThread = z.infer<typeof messageThreadSchema>;

export const createWorkItemSchema = z.object({
  type: workItemTypeSchema,
  title: z.string().trim().min(1).max(240),
  ownerId: identifierSchema.nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']).nullable().optional(),
  externalReferences: z.array(externalReferenceSchema).max(20).default([]),
});
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;

export const domainEventSchema = z.object({
  id: identifierSchema,
  cursor: z.number().int().positive(),
  version: z.literal(1),
  tenantId: identifierSchema,
  channelId: identifierSchema.nullable().default(null),
  audienceUserIds: z.array(identifierSchema),
  type: z.enum([
    'message.created',
    'message.updated',
    'message.deleted',
    'reaction.added',
    'reaction.removed',
    'channel.read',
    'work_item.created',
  ]),
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});
export type DomainEvent = z.infer<typeof domainEventSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
