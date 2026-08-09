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

export const messageSchema = z.object({
  id: identifierSchema,
  channelId: identifierSchema,
  threadRootId: identifierSchema.nullable(),
  sequence: z.number().int().positive(),
  author: userSchema,
  blocks: z.array(messageBlockSchema).min(1),
  revision: z.number().int().positive(),
  replyCount: z.number().int().nonnegative(),
  reactions: z.record(z.string(), z.array(identifierSchema)),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
});
export type Message = z.infer<typeof messageSchema>;

export const externalReferenceSchema = z.object({
  provider: z.enum(['github', 'gitlab', 'jira', 'youtrack', 'sentry', 'grafana', 'other']),
  externalId: z.string(),
  url: z.string().url(),
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
  blocks: z.array(messageBlockSchema).min(1).max(30),
});
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

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
  audienceUserIds: z.array(identifierSchema),
  type: z.enum(['message.created', 'message.updated', 'message.deleted', 'work_item.created']),
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

