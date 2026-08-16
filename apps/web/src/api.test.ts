import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@work-chat/contracts';
import { api, DEV_TENANT_ID, DEV_USER_ID } from './api.js';

const ids = {
  channel: '44444444-4444-4444-8444-444444444445',
  message: '55555555-5555-4555-8555-555555555555',
  user: '22222222-2222-4222-8222-222222222222',
};

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: ids.message,
    channelId: ids.channel,
    threadRootId: null,
    sequence: 3,
    author: {
      id: ids.user,
      displayName: 'Данил Соколов',
      email: 'danil@example.ru',
      avatarUrl: null,
      status: 'online',
    },
    blocks: [{ type: 'text', text: 'Сообщение' }],
    revision: 1,
    replyCount: 0,
    reactions: {},
    createdAt: '2026-08-16T10:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('message lifecycle API', () => {
  it('sends revision-protected edit and delete requests with idempotency keys', async () => {
    fetchMock.mockResolvedValueOnce(
      response(message({ revision: 2, editedAt: '2026-08-16T11:00:00.000Z' })),
    );
    await api.editMessage(
      ids.message,
      {
        blocks: [{ type: 'text', text: 'Обновлено' }],
        expectedRevision: 1,
      },
      'edit-key',
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `http://localhost:3000/v1/messages/${ids.message}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          blocks: [{ type: 'text', text: 'Обновлено' }],
          expectedRevision: 1,
        }),
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-tenant-id': DEV_TENANT_ID,
          'x-user-id': DEV_USER_ID,
          'Idempotency-Key': 'edit-key',
        }),
      }),
    );

    fetchMock.mockResolvedValueOnce(
      response(message({ blocks: [], revision: 3, deletedAt: '2026-08-16T12:00:00.000Z' })),
    );
    await api.deleteMessage(ids.message, { expectedRevision: 2 }, 'delete-key');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `http://localhost:3000/v1/messages/${ids.message}`,
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision: 2 }),
        headers: expect.objectContaining({ 'Idempotency-Key': 'delete-key' }),
      }),
    );
  });

  it('uses idempotent reaction methods and validates their message snapshots', async () => {
    fetchMock
      .mockResolvedValueOnce(response(message({ reactions: { '👍': [ids.user] } })))
      .mockResolvedValueOnce(response(message()));

    await api.addReaction(ids.message, { emoji: '👍' });
    await api.removeReaction(ids.message, { emoji: '👍' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `http://localhost:3000/v1/messages/${ids.message}/reactions`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ emoji: '👍' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `http://localhost:3000/v1/messages/${ids.message}/reactions`,
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ emoji: '👍' }),
      }),
    );

    fetchMock.mockResolvedValueOnce(response({ unexpected: true }));
    await expect(api.addReaction(ids.message, { emoji: '🚀' })).rejects.toMatchObject({
      name: 'ZodError',
    });
  });

  it('encodes the thread cursor and parses a paginated thread', async () => {
    const root = message({ replyCount: 1 });
    const reply = message({
      id: '66666666-6666-4666-8666-666666666666',
      threadRootId: ids.message,
      sequence: 4,
    });
    fetchMock.mockResolvedValueOnce(response({ root, replies: [reply], nextCursor: null }));

    await expect(api.thread(ids.message, 'page/+=?')).resolves.toEqual({
      root,
      replies: [reply],
      nextCursor: null,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3000/v1/messages/${ids.message}/thread?cursor=page%2F%2B%3D%3F`,
    );
  });

  it('updates read state and surfaces the server error envelope', async () => {
    const readState = {
      channelId: ids.channel,
      lastReadSequence: 8,
      unreadCount: 0,
      updatedAt: '2026-08-16T12:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(response(readState));
    await expect(api.markRead(ids.channel, { lastReadSequence: 8 })).resolves.toEqual(readState);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `http://localhost:3000/v1/channels/${ids.channel}/read-state`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ lastReadSequence: 8 }),
      }),
    );

    fetchMock.mockResolvedValueOnce(
      response(
        {
          error: {
            code: 'REVISION_CONFLICT',
            message: 'Сообщение уже изменено',
            requestId: 'request-1',
          },
        },
        409,
      ),
    );
    await expect(
      api.deleteMessage(ids.message, { expectedRevision: 1 }, 'conflict-key'),
    ).rejects.toThrow('Сообщение уже изменено');
  });
});
