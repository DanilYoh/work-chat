import {
  bootstrapResponseSchema,
  domainEventSchema,
  messageSchema,
  workItemSchema,
  type BootstrapResponse,
  type CreateMessageInput,
  type CreateWorkItemInput,
  type CursorPage,
  type DomainEvent,
  type Message,
  type WorkItem,
} from '@work-chat/contracts';
import { z } from 'zod';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
export const REALTIME_URL = import.meta.env.VITE_REALTIME_URL ?? 'ws://localhost:3001/v1/events';
export const DEV_TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const DEV_USER_ID = '22222222-2222-4222-8222-222222222222';

async function request<T>(path: string, schema: z.ZodType<T>, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': DEV_TENANT_ID,
      'x-user-id': DEV_USER_ID,
      ...options?.headers,
    },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const candidate = body as { error?: { message?: string } };
    throw new Error(candidate.error?.message ?? `HTTP ${response.status}`);
  }
  return schema.parse(body);
}

const messagePageSchema = z.object({ items: z.array(messageSchema), nextCursor: z.string().nullable() });
const eventPageSchema = z.object({ items: z.array(domainEventSchema), nextCursor: z.string().nullable() });

export const api = {
  bootstrap: (): Promise<BootstrapResponse> => request('/v1/bootstrap', bootstrapResponseSchema),
  messages: (channelId: string): Promise<CursorPage<Message>> =>
    request(`/v1/channels/${channelId}/messages`, messagePageSchema),
  sendMessage: (channelId: string, input: CreateMessageInput): Promise<Message> =>
    request(`/v1/channels/${channelId}/messages`, messageSchema, {
      method: 'POST',
      headers: { 'Idempotency-Key': input.clientId },
      body: JSON.stringify(input),
    }),
  workItems: (channelId?: string): Promise<WorkItem[]> =>
    request(`/v1/work-items${channelId ? `?channelId=${channelId}` : ''}`, z.array(workItemSchema)),
  createWorkItem: (messageId: string, input: CreateWorkItemInput): Promise<WorkItem> =>
    request(`/v1/messages/${messageId}/work-items`, workItemSchema, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  sync: (cursor?: string): Promise<CursorPage<DomainEvent>> =>
    request(`/v1/sync${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, eventPageSchema),
};

