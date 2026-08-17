import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapResponse, DomainEvent, Message } from '@work-chat/contracts';
import { useWorkspace } from './useWorkspace.js';

const mocks = vi.hoisted(() => ({
  api: {
    bootstrap: vi.fn(),
    messages: vi.fn(),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    thread: vi.fn(),
    markRead: vi.fn(),
    workItems: vi.fn(),
    createWorkItem: vi.fn(),
    sync: vi.fn(),
  },
}));

vi.mock('./api.js', () => ({
  api: mocks.api,
  DEV_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  DEV_USER_ID: '22222222-2222-4222-8222-222222222222',
  REALTIME_URL: 'ws://localhost:3001/v1/events',
}));

const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  other: '22222222-2222-4222-8222-222222222223',
  space: '33333333-3333-4333-8333-333333333333',
  channel: '44444444-4444-4444-8444-444444444445',
  secondChannel: '44444444-4444-4444-8444-444444444446',
  root: '55555555-5555-4555-8555-555555555555',
  reply: '66666666-6666-4666-8666-666666666666',
};

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: ids.root,
    channelId: ids.channel,
    threadRootId: null,
    sequence: 1,
    author: {
      id: ids.user,
      displayName: 'Данил Соколов',
      email: 'danil@example.ru',
      avatarUrl: null,
      status: 'online',
    },
    blocks: [{ type: 'text', text: 'Исходное сообщение' }],
    revision: 1,
    replyCount: 0,
    reactions: {},
    createdAt: '2026-08-16T10:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function bootstrap(): BootstrapResponse {
  return {
    organization: { id: ids.tenant, name: 'Orbit Labs', slug: 'orbit-labs' },
    currentUser: message().author,
    spaces: [
      {
        id: ids.space,
        name: 'Platform',
        slug: 'platform',
        channels: [
          {
            id: ids.channel,
            spaceId: ids.space,
            name: 'Backend',
            slug: 'backend',
            description: 'API',
            kind: 'public',
            latestSequence: 1,
            lastReadSequence: 0,
            unreadCount: 1,
          },
          {
            id: ids.secondChannel,
            spaceId: ids.space,
            name: 'Frontend',
            slug: 'frontend',
            description: 'UI',
            kind: 'public',
            latestSequence: 0,
            lastReadSequence: 0,
            unreadCount: 0,
          },
        ],
      },
    ],
    directMessages: [],
  };
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  emit(event: DomainEvent) {
    this.onmessage?.({ data: JSON.stringify({ type: 'event', event }) });
  }
}

function domainEvent(
  id: string,
  cursor: number,
  type: DomainEvent['type'],
  payload: Record<string, unknown>,
): DomainEvent {
  const scopedPayload = payload.message ?? payload.readState ?? payload.workItem;
  const channelId =
    typeof scopedPayload === 'object' &&
    scopedPayload !== null &&
    'channelId' in scopedPayload &&
    typeof scopedPayload.channelId === 'string'
      ? scopedPayload.channelId
      : null;
  const event: DomainEvent & { channelId: string | null } = {
    id,
    cursor,
    version: 1,
    tenantId: ids.tenant,
    channelId,
    audienceUserIds: [ids.user],
    type,
    occurredAt: '2026-08-16T12:00:00.000Z',
    payload,
  };
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '77777777-7777-4777-8777-777777777777') });
  Object.values(mocks.api).forEach((mock) => mock.mockReset());
  mocks.api.bootstrap.mockResolvedValue(bootstrap());
  mocks.api.messages.mockResolvedValue({ items: [message()], nextCursor: null });
  mocks.api.workItems.mockResolvedValue([]);
  mocks.api.markRead.mockImplementation((channelId: string, input: { lastReadSequence: number }) =>
    Promise.resolve({
      channelId,
      lastReadSequence: input.lastReadSequence,
      unreadCount: 0,
      updatedAt: '2026-08-16T12:00:00.000Z',
    }),
  );
  mocks.api.sync.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function initializedWorkspace() {
  const hook = renderHook(() => useWorkspace());
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(1));
  return hook;
}

describe('useWorkspace message state', () => {
  it('buffers pre-bootstrap realtime events and deduplicates their later sync replay', async () => {
    const bootstrapRequest = deferred<BootstrapResponse>();
    mocks.api.bootstrap.mockReturnValueOnce(bootstrapRequest.promise);
    const incoming = message({
      id: '55555555-5555-4555-8555-555555555560',
      channelId: ids.secondChannel,
      sequence: 1,
      author: { ...message().author, id: ids.other },
    });
    const event = domainEvent('88888888-8888-4888-8888-888888888897', 21, 'message.created', {
      message: incoming,
      threadRoot: null,
    });
    const activeIncoming = message({
      id: '55555555-5555-4555-8555-555555555561',
      sequence: 2,
    });
    const activeEvent = domainEvent('88888888-8888-4888-8888-888888888898', 22, 'message.created', {
      message: activeIncoming,
      threadRoot: null,
    });
    mocks.api.sync.mockResolvedValue({ items: [event, activeEvent], nextCursor: 'cursor-22' });
    const hook = renderHook(() => useWorkspace());

    act(() => {
      FakeWebSocket.instances[0]!.emit(activeEvent);
      FakeWebSocket.instances[0]!.emit(event);
    });
    expect(hook.result.current.bootstrap).toBeNull();

    await act(async () => {
      bootstrapRequest.resolve(bootstrap());
      await bootstrapRequest.promise;
    });
    await waitFor(() => {
      const channel = hook.result.current.bootstrap?.spaces[0]?.channels[1];
      expect(channel).toMatchObject({ latestSequence: 1, unreadCount: 1 });
    });
    await waitFor(() =>
      expect(hook.result.current.messages.map((item) => item.id)).toEqual([
        ids.root,
        activeIncoming.id,
      ]),
    );

    await waitFor(() => expect(mocks.api.sync).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const channel = hook.result.current.bootstrap?.spaces[0]?.channels[1];
    expect(channel).toMatchObject({ latestSequence: 1, unreadCount: 1 });
    expect(
      hook.result.current.messages.filter((item) => item.id === activeIncoming.id),
    ).toHaveLength(1);
  });

  it('applies HTTP edit/delete snapshots and never restores an older revision event', async () => {
    const hook = await initializedWorkspace();
    const edited = message({
      blocks: [{ type: 'text', text: 'Новая версия' }],
      revision: 2,
      editedAt: '2026-08-16T11:00:00.000Z',
    });
    mocks.api.editMessage.mockResolvedValue(edited);
    await act(() => hook.result.current.editMessage(ids.root, edited.blocks, 1));
    expect(hook.result.current.messages[0]?.blocks).toEqual(edited.blocks);

    FakeWebSocket.instances[0]!.emit(
      domainEvent('88888888-8888-4888-8888-888888888881', 5, 'message.updated', {
        message: message({ blocks: [{ type: 'text', text: 'Устаревшая версия' }], revision: 1 }),
      }),
    );
    await waitFor(() => expect(hook.result.current.messages[0]?.revision).toBe(2));
    expect(hook.result.current.messages[0]?.blocks).toEqual(edited.blocks);

    const deleted = message({
      blocks: [],
      revision: 3,
      editedAt: edited.editedAt,
      deletedAt: '2026-08-16T12:30:00.000Z',
    });
    mocks.api.deleteMessage.mockResolvedValue(deleted);
    await act(() => hook.result.current.deleteMessage(ids.root, 2));
    expect(hook.result.current.messages[0]).toMatchObject({
      revision: 3,
      blocks: [],
      deletedAt: deleted.deletedAt,
    });
  });

  it('deduplicates events and orders same-revision reaction snapshots by cursor', async () => {
    const hook = await initializedWorkspace();
    const socket = FakeWebSocket.instances[0]!;
    const addedId = '88888888-8888-4888-8888-888888888882';
    socket.emit(
      domainEvent(addedId, 10, 'reaction.added', {
        message: message({ reactions: { '👍': [ids.user] } }),
      }),
    );
    await waitFor(() =>
      expect(hook.result.current.messages[0]?.reactions).toEqual({ '👍': [ids.user] }),
    );

    socket.emit(
      domainEvent('88888888-8888-4888-8888-888888888883', 9, 'reaction.removed', {
        message: message({ reactions: {} }),
      }),
    );
    socket.emit(
      domainEvent(addedId, 11, 'reaction.removed', {
        message: message({ reactions: {} }),
      }),
    );
    await act(async () => Promise.resolve());
    expect(hook.result.current.messages[0]?.reactions).toEqual({ '👍': [ids.user] });

    socket.emit(
      domainEvent('88888888-8888-4888-8888-888888888884', 11, 'reaction.removed', {
        message: message({ reactions: {} }),
      }),
    );
    await waitFor(() => expect(hook.result.current.messages[0]?.reactions).toEqual({}));
  });

  it('does not apply a stale reaction response after a newer realtime reaction event', async () => {
    const response = deferred<Message>();
    mocks.api.addReaction.mockReturnValueOnce(response.promise);
    const hook = await initializedWorkspace();
    let request!: Promise<void>;

    act(() => {
      request = hook.result.current.toggleReaction(ids.root, '👍', false);
    });
    act(() => {
      FakeWebSocket.instances[0]!.emit(
        domainEvent('88888888-8888-4888-8888-888888888890', 12, 'reaction.added', {
          message: message({ reactions: { '🚀': [ids.other] } }),
        }),
      );
    });
    await waitFor(() =>
      expect(hook.result.current.messages[0]?.reactions).toEqual({ '🚀': [ids.other] }),
    );

    response.resolve(message({ reactions: { '👍': [ids.user] } }));
    await act(async () => request);
    expect(hook.result.current.messages[0]?.reactions).toEqual({ '🚀': [ids.other] });
  });

  it('does not let a stale initial channel response overwrite realtime content and reactions', async () => {
    const initialPage = deferred<{ items: Message[]; nextCursor: string | null }>();
    mocks.api.messages.mockReturnValueOnce(initialPage.promise);
    const hook = renderHook(() => useWorkspace());
    await waitFor(() => expect(hook.result.current.activeChannelId).toBe(ids.channel));
    await waitFor(() => expect(mocks.api.messages).toHaveBeenCalledWith(ids.channel));

    const updated = message({
      blocks: [{ type: 'text', text: 'Версия из realtime' }],
      revision: 2,
      editedAt: '2026-08-16T11:00:00.000Z',
    });
    act(() => {
      FakeWebSocket.instances[0]!.emit(
        domainEvent('88888888-8888-4888-8888-888888888888', 20, 'message.updated', {
          message: updated,
        }),
      );
      FakeWebSocket.instances[0]!.emit(
        domainEvent('88888888-8888-4888-8888-888888888889', 21, 'reaction.added', {
          message: { ...updated, reactions: { '🚀': [ids.user] } },
        }),
      );
    });
    await waitFor(() =>
      expect(hook.result.current.messages[0]).toMatchObject({
        revision: 2,
        blocks: updated.blocks,
        reactions: { '🚀': [ids.user] },
      }),
    );

    initialPage.resolve({ items: [message()], nextCursor: null });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.messages[0]).toMatchObject({
      revision: 2,
      blocks: updated.blocks,
      reactions: { '🚀': [ids.user] },
    });
  });

  it('does not let a stale thread response roll back a realtime reaction', async () => {
    const threadPage = deferred<{ root: Message; replies: Message[]; nextCursor: string | null }>();
    mocks.api.thread.mockReturnValueOnce(threadPage.promise);
    const hook = await initializedWorkspace();
    let opening!: Promise<void>;
    act(() => {
      opening = hook.result.current.openThread(ids.root);
    });
    await waitFor(() => expect(hook.result.current.activeThreadId).toBe(ids.root));

    act(() =>
      FakeWebSocket.instances[0]!.emit(
        domainEvent('99999999-9999-4999-8999-999999999991', 22, 'reaction.added', {
          message: message({ reactions: { '👍': [ids.user] } }),
        }),
      ),
    );
    await waitFor(() =>
      expect(hook.result.current.thread?.root.reactions).toEqual({ '👍': [ids.user] }),
    );

    threadPage.resolve({ root: message({ reactions: {} }), replies: [], nextCursor: null });
    await act(async () => opening);
    expect(hook.result.current.messages[0]?.reactions).toEqual({ '👍': [ids.user] });
    expect(hook.result.current.thread?.root.reactions).toEqual({ '👍': [ids.user] });
  });

  it('loads the newest roots first, prepends older pages, and does not regress read state', async () => {
    const oldestRoot = message();
    const olderRoot = message({
      id: '55555555-5555-4555-8555-555555555552',
      sequence: 2,
      blocks: [{ type: 'text', text: 'Более старое сообщение' }],
    });
    const recentRoot = message({
      id: '55555555-5555-4555-8555-555555555553',
      sequence: 4,
      blocks: [{ type: 'text', text: 'Недавнее сообщение' }],
    });
    const newestRoot = message({
      id: '55555555-5555-4555-8555-555555555554',
      sequence: 5,
      blocks: [{ type: 'text', text: 'Новейшее сообщение' }],
    });
    const initialBootstrap = bootstrap();
    initialBootstrap.spaces[0]!.channels[0] = {
      ...initialBootstrap.spaces[0]!.channels[0]!,
      latestSequence: 5,
      unreadCount: 5,
    };
    mocks.api.bootstrap.mockResolvedValueOnce(initialBootstrap);
    mocks.api.messages
      .mockResolvedValueOnce({ items: [recentRoot, newestRoot], nextCursor: 'older-page' })
      .mockResolvedValueOnce({ items: [oldestRoot, olderRoot], nextCursor: null });

    const hook = renderHook(() => useWorkspace());
    await waitFor(() => expect(hook.result.current.messageCursor).toBe('older-page'));
    expect(hook.result.current.messages.map((item) => item.id)).toEqual([
      recentRoot.id,
      newestRoot.id,
    ]);
    await waitFor(() =>
      expect(mocks.api.markRead).toHaveBeenCalledWith(ids.channel, { lastReadSequence: 5 }),
    );
    await waitFor(() => expect(hook.result.current.activeChannel?.lastReadSequence).toBe(5));
    mocks.api.markRead.mockClear();

    await act(() => hook.result.current.loadMoreMessages());
    expect(mocks.api.messages).toHaveBeenNthCalledWith(2, ids.channel, 'older-page');
    expect(hook.result.current.messages.map((item) => item.id)).toEqual([
      oldestRoot.id,
      olderRoot.id,
      recentRoot.id,
      newestRoot.id,
    ]);
    expect(hook.result.current.messageCursor).toBeNull();
    expect(mocks.api.markRead).not.toHaveBeenCalled();
    expect(hook.result.current.activeChannel?.lastReadSequence).toBe(5);
  });

  it('retries a failed channel load and clears the visible error', async () => {
    mocks.api.messages
      .mockRejectedValueOnce(new Error('Не удалось загрузить сообщения'))
      .mockResolvedValueOnce({ items: [message()], nextCursor: null });
    const hook = renderHook(() => useWorkspace());
    await waitFor(() => expect(hook.result.current.error).toBe('Не удалось загрузить сообщения'));
    expect(hook.result.current.messages).toEqual([]);

    act(() => hook.result.current.reloadChannel());
    await waitFor(() => expect(hook.result.current.messages).toHaveLength(1));
    expect(hook.result.current.error).toBeNull();
    expect(mocks.api.messages).toHaveBeenCalledTimes(2);
  });

  it('reuses idempotency keys after ambiguous failures and rotates them after success', async () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777771')
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777772')
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777773')
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777774');
    vi.stubGlobal('crypto', { randomUUID });
    const hook = await initializedWorkspace();
    const ambiguousNetworkError = new Error('Connection closed before the response');
    const sentOnce = message({
      id: '55555555-5555-4555-8555-555555555553',
      sequence: 2,
      blocks: [{ type: 'text', text: 'Retry-safe message' }],
    });
    const sentTwice = message({
      id: '55555555-5555-4555-8555-555555555554',
      sequence: 3,
      blocks: sentOnce.blocks,
    });
    mocks.api.sendMessage
      .mockRejectedValueOnce(ambiguousNetworkError)
      .mockResolvedValueOnce(sentOnce)
      .mockResolvedValueOnce(sentTwice);

    await act(async () => {
      await expect(hook.result.current.sendMessage('Retry-safe message')).rejects.toBe(
        ambiguousNetworkError,
      );
    });
    await act(() => hook.result.current.sendMessage('Retry-safe message'));
    await act(() => hook.result.current.sendMessage('Retry-safe message'));

    const firstClientId = mocks.api.sendMessage.mock.calls[0]?.[1].clientId;
    expect(mocks.api.sendMessage.mock.calls[1]?.[1].clientId).toBe(firstClientId);
    expect(mocks.api.sendMessage.mock.calls[2]?.[1].clientId).not.toBe(firstClientId);

    const edited = message({
      blocks: [{ type: 'text', text: 'Retry-safe edit' }],
      revision: 2,
      editedAt: '2026-08-16T11:00:00.000Z',
    });
    mocks.api.editMessage
      .mockRejectedValueOnce(ambiguousNetworkError)
      .mockResolvedValueOnce(edited)
      .mockResolvedValueOnce(edited);

    await act(async () => {
      await expect(hook.result.current.editMessage(ids.root, edited.blocks, 1)).rejects.toBe(
        ambiguousNetworkError,
      );
    });
    await act(() => hook.result.current.editMessage(ids.root, edited.blocks, 1));
    await act(() => hook.result.current.editMessage(ids.root, edited.blocks, 1));

    const firstEditKey = mocks.api.editMessage.mock.calls[0]?.[2];
    expect(mocks.api.editMessage.mock.calls[1]?.[2]).toBe(firstEditKey);
    expect(mocks.api.editMessage.mock.calls[2]?.[2]).not.toBe(firstEditKey);
    expect(randomUUID).toHaveBeenCalledTimes(4);
  });

  it('keeps replies out of the timeline and upserts the absolute thread root once', async () => {
    const root = message();
    mocks.api.thread.mockResolvedValue({ root, replies: [], nextCursor: null });
    const hook = await initializedWorkspace();
    await waitFor(() =>
      expect(mocks.api.markRead).toHaveBeenCalledWith(ids.channel, { lastReadSequence: 1 }),
    );
    mocks.api.markRead.mockClear();
    await act(() => hook.result.current.openThread(ids.root));

    const reply = message({
      id: ids.reply,
      threadRootId: ids.root,
      sequence: 2,
      author: { ...message().author, id: ids.other },
      blocks: [{ type: 'text', text: 'Ответ' }],
    });
    const updatedRoot = message({ replyCount: 1 });
    const replyEvent = domainEvent('88888888-8888-4888-8888-888888888885', 12, 'message.created', {
      message: reply,
      threadRoot: updatedRoot,
    });
    FakeWebSocket.instances[0]!.emit(replyEvent);
    FakeWebSocket.instances[0]!.emit(replyEvent);

    await waitFor(() => expect(hook.result.current.thread?.replies).toHaveLength(1));
    expect(hook.result.current.messages).toHaveLength(1);
    expect(hook.result.current.messages[0]).toMatchObject({ id: ids.root, replyCount: 1 });
    expect(hook.result.current.thread?.root.replyCount).toBe(1);
    expect(mocks.api.markRead).toHaveBeenCalledWith(ids.channel, { lastReadSequence: 2 });
  });

  it('keeps a foreign reply unread while its thread is closed', async () => {
    const hook = await initializedWorkspace();
    await waitFor(() =>
      expect(mocks.api.markRead).toHaveBeenCalledWith(ids.channel, { lastReadSequence: 1 }),
    );
    mocks.api.markRead.mockClear();
    const reply = message({
      id: '66666666-6666-4666-8666-666666666667',
      threadRootId: ids.root,
      sequence: 2,
      author: { ...message().author, id: ids.other },
      blocks: [{ type: 'text', text: 'Hidden thread reply' }],
    });

    act(() => {
      FakeWebSocket.instances[0]!.emit(
        domainEvent('88888888-8888-4888-8888-888888888892', 16, 'message.created', {
          message: reply,
          threadRoot: message({ replyCount: 1 }),
        }),
      );
    });

    await waitFor(() => {
      const channel = hook.result.current.bootstrap?.spaces[0]?.channels[0];
      expect(channel).toMatchObject({ latestSequence: 2, lastReadSequence: 1, unreadCount: 1 });
    });
    expect(hook.result.current.thread).toBeNull();
    expect(mocks.api.markRead).not.toHaveBeenCalled();
  });

  it('increments inactive-channel unread state only for a new sequence and applies an absolute read event', async () => {
    const hook = await initializedWorkspace();
    const secondMessage = message({
      id: '55555555-5555-4555-8555-555555555556',
      channelId: ids.secondChannel,
      sequence: 1,
      author: { ...message().author, id: ids.other },
    });
    FakeWebSocket.instances[0]!.emit(
      domainEvent('88888888-8888-4888-8888-888888888886', 13, 'message.created', {
        message: secondMessage,
      }),
    );
    await waitFor(() => {
      const channel = hook.result.current.bootstrap?.spaces[0]?.channels[1];
      expect(channel).toMatchObject({ latestSequence: 1, unreadCount: 1 });
    });

    FakeWebSocket.instances[0]!.emit(
      domainEvent('88888888-8888-4888-8888-888888888887', 14, 'channel.read', {
        readState: {
          channelId: ids.secondChannel,
          lastReadSequence: 1,
          unreadCount: 0,
          updatedAt: '2026-08-16T13:00:00.000Z',
        },
      }),
    );
    await waitFor(() => {
      const channel = hook.result.current.bootstrap?.spaces[0]?.channels[1];
      expect(channel).toMatchObject({ lastReadSequence: 1, unreadCount: 0 });
    });
  });

  it('advances an inactive channel without adding unread for a historical create tombstone', async () => {
    const hook = await initializedWorkspace();
    const tombstone = message({
      id: '55555555-5555-4555-8555-555555555557',
      channelId: ids.secondChannel,
      sequence: 1,
      author: { ...message().author, id: ids.other },
      blocks: [],
      deletedAt: '2026-08-16T13:30:00.000Z',
    });

    act(() => {
      FakeWebSocket.instances[0]!.emit(
        domainEvent('88888888-8888-4888-8888-888888888891', 15, 'message.created', {
          message: tombstone,
          threadRoot: null,
        }),
      );
    });

    await waitFor(() => {
      const channel = hook.result.current.bootstrap?.spaces[0]?.channels[1];
      expect(channel).toMatchObject({ latestSequence: 1, unreadCount: 0 });
    });
  });

  it('decrements unread only for a message previously counted by the local reducer', async () => {
    const initial = bootstrap();
    const inactive = initial.spaces[0]!.channels[1]!;
    inactive.latestSequence = 2;
    inactive.unreadCount = 1;
    mocks.api.bootstrap.mockResolvedValueOnce(initial);
    const hook = await initializedWorkspace();
    const historicalTombstone = message({
      id: '55555555-5555-4555-8555-555555555558',
      channelId: ids.secondChannel,
      sequence: 1,
      author: { ...message().author, id: ids.other },
      blocks: [],
      revision: 2,
      deletedAt: '2026-08-16T13:35:00.000Z',
    });

    act(() => {
      FakeWebSocket.instances[0]!.emit(
        domainEvent('88888888-8888-4888-8888-888888888893', 17, 'message.created', {
          message: historicalTombstone,
          threadRoot: null,
        }),
      );
      FakeWebSocket.instances[0]!.emit(
        domainEvent('88888888-8888-4888-8888-888888888894', 18, 'message.deleted', {
          message: historicalTombstone,
        }),
      );
    });
    await waitFor(() => {
      const channel = hook.result.current.bootstrap?.spaces[0]?.channels[1];
      expect(channel).toMatchObject({ latestSequence: 2, unreadCount: 1 });
    });

    const liveMessage = message({
      id: '55555555-5555-4555-8555-555555555559',
      channelId: ids.secondChannel,
      sequence: 3,
      author: { ...message().author, id: ids.other },
    });
    act(() => {
      FakeWebSocket.instances[0]!.emit(
        domainEvent('88888888-8888-4888-8888-888888888895', 19, 'message.created', {
          message: liveMessage,
          threadRoot: null,
        }),
      );
    });
    await waitFor(() => {
      const channel = hook.result.current.bootstrap?.spaces[0]?.channels[1];
      expect(channel).toMatchObject({ latestSequence: 3, unreadCount: 2 });
    });

    act(() => {
      FakeWebSocket.instances[0]!.emit(
        domainEvent('88888888-8888-4888-8888-888888888896', 20, 'message.deleted', {
          message: {
            ...liveMessage,
            blocks: [],
            revision: 2,
            deletedAt: '2026-08-16T13:40:00.000Z',
          },
        }),
      );
    });
    await waitFor(() => {
      const channel = hook.result.current.bootstrap?.spaces[0]?.channels[1];
      expect(channel).toMatchObject({ latestSequence: 3, unreadCount: 1 });
    });
  });
});
