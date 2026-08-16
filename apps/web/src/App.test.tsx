import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@work-chat/contracts';
import { App } from './App.js';

const mocks = vi.hoisted(() => ({ useWorkspace: vi.fn() }));

vi.mock('./useWorkspace.js', () => ({ useWorkspace: mocks.useWorkspace }));

const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  other: '22222222-2222-4222-8222-222222222223',
  space: '33333333-3333-4333-8333-333333333333',
  channel: '44444444-4444-4444-8444-444444444445',
  root: '55555555-5555-4555-8555-555555555555',
  reply: '66666666-6666-4666-8666-666666666666',
};

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: ids.root,
    channelId: ids.channel,
    threadRootId: null,
    sequence: 2,
    author: {
      id: ids.user,
      displayName: 'Данил Соколов',
      email: 'danil@example.ru',
      avatarUrl: null,
      status: 'online',
    },
    blocks: [{ type: 'text', text: 'Проверяем жизненный цикл сообщения' }],
    revision: 1,
    replyCount: 0,
    reactions: {},
    createdAt: '2026-08-16T10:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function workspace(overrides: Record<string, unknown> = {}) {
  const activeChannel = {
    id: ids.channel,
    spaceId: ids.space,
    name: 'Backend',
    slug: 'backend',
    description: 'API и архитектура',
    kind: 'public' as const,
    latestSequence: 2,
    lastReadSequence: 0,
    unreadCount: 1,
  };
  return {
    bootstrap: {
      organization: { id: ids.tenant, name: 'Orbit Labs', slug: 'orbit-labs' },
      currentUser: {
        id: ids.user,
        displayName: 'Данил Соколов',
        email: 'danil@example.ru',
        avatarUrl: null,
        status: 'online' as const,
      },
      spaces: [{ id: ids.space, name: 'Platform', slug: 'platform', channels: [activeChannel] }],
      directMessages: [],
    },
    activeChannel,
    activeChannelId: ids.channel,
    setActiveChannelId: vi.fn(),
    messages: [] as Message[],
    messageCursor: null,
    messagesLoadingMore: false,
    loadMoreMessages: vi.fn().mockResolvedValue(undefined),
    reloadChannel: vi.fn(),
    workItems: [],
    loading: false,
    error: null,
    realtime: 'online',
    sendMessage: vi.fn().mockResolvedValue(undefined),
    promote: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    toggleReaction: vi.fn().mockResolvedValue(undefined),
    activeThreadId: null,
    thread: null,
    threadLoading: false,
    threadError: null,
    openThread: vi.fn().mockResolvedValue(undefined),
    closeThread: vi.fn(),
    loadMoreReplies: vi.fn().mockResolvedValue(undefined),
    sendReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.useWorkspace.mockReset();
  mocks.useWorkspace.mockReturnValue(workspace());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('workspace shell', () => {
  it('renders the organization, channel and context panel', () => {
    render(<App />);
    expect(screen.getByText('Orbit Labs')).toBeTruthy();
    expect(screen.getAllByText('Backend').length).toBeGreaterThan(0);
    expect(screen.getByText('Рабочий контекст')).toBeTruthy();
  });

  it('edits every block inline and sends the expected revision', async () => {
    const editMessage = vi.fn().mockResolvedValue(undefined);
    mocks.useWorkspace.mockReturnValue(
      workspace({
        messages: [
          message({
            blocks: [
              { type: 'text', text: 'Старый текст' },
              { type: 'code', code: 'const oldValue = true;', language: 'ts' },
            ],
          }),
        ],
        editMessage,
      }),
    );
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Изменить сообщение' }));
    fireEvent.change(screen.getByLabelText('Текст, блок 1'), { target: { value: 'Новый текст' } });
    fireEvent.change(screen.getByLabelText('Код, блок 2'), {
      target: { value: 'const newValue = true;' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));

    await waitFor(() =>
      expect(editMessage).toHaveBeenCalledWith(
        ids.root,
        [
          { type: 'text', text: 'Новый текст' },
          { type: 'code', code: 'const newValue = true;', language: 'ts' },
        ],
        1,
      ),
    );
  });

  it('shows edit and delete only to the author and confirms deletion', async () => {
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.useWorkspace.mockReturnValue(workspace({ messages: [message()], deleteMessage }));
    const view = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Удалить сообщение' }));
    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith(ids.root, 1));
    expect(confirm).toHaveBeenCalledOnce();

    mocks.useWorkspace.mockReturnValue(
      workspace({
        messages: [message({ author: { ...message().author, id: ids.other } })],
      }),
    );
    view.rerender(<App />);
    expect(screen.queryByRole('button', { name: 'Изменить сообщение' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Удалить сообщение' })).toBeNull();
  });

  it('renders a tombstone without exposing deleted content to search or promotion', () => {
    mocks.useWorkspace.mockReturnValue(
      workspace({
        messages: [
          message({
            blocks: [{ type: 'text', text: 'секретный удалённый текст' }],
            deletedAt: '2026-08-16T11:00:00.000Z',
          }),
        ],
      }),
    );
    render(<App />);

    expect(screen.getByText('Сообщение удалено')).toBeTruthy();
    expect(screen.queryByText('секретный удалённый текст')).toBeNull();
    expect(screen.queryByRole('button', { name: /В контекст/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Поиск в канале'), {
      target: { value: 'секретный' },
    });
    expect(screen.queryByText('Сообщение удалено')).toBeNull();
  });

  it('toggles an existing reaction and adds one from the quick picker', async () => {
    const toggleReaction = vi.fn().mockResolvedValue(undefined);
    mocks.useWorkspace.mockReturnValue(
      workspace({
        messages: [message({ reactions: { '👍': [ids.user] } })],
        toggleReaction,
      }),
    );
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Убрать реакцию 👍' }));
    await waitFor(() => expect(toggleReaction).toHaveBeenCalledWith(ids.root, '👍', true));

    fireEvent.click(screen.getByRole('button', { name: 'Добавить реакцию' }));
    const picker = screen.getByRole('group', { name: 'Быстрые реакции' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Добавить реакцию 🚀' }));
    await waitFor(() => expect(toggleReaction).toHaveBeenCalledWith(ids.root, '🚀', false));
  });

  it('shows a channel error, hides the empty state and retries loading', () => {
    const reloadChannel = vi.fn();
    mocks.useWorkspace.mockReturnValue(
      workspace({
        error: 'Не удалось загрузить сообщения',
        messages: [],
        reloadChannel,
      }),
    );
    render(<App />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Не удалось загрузить сообщения')).toBeTruthy();
    expect(screen.queryByText('Здесь пока тихо. Начните обсуждение.')).toBeNull();
    expect(
      (screen.getByPlaceholderText('Сообщение в #Backend') as HTMLTextAreaElement).disabled,
    ).toBe(true);
    fireEvent.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(reloadChannel).toHaveBeenCalledOnce();
  });

  it('isolates the context panel and restores promotion focus after inert is removed', async () => {
    mocks.useWorkspace.mockReturnValue(workspace({ messages: [message()] }));
    render(<App />);
    const trigger = screen.getByRole('button', { name: /В контекст/ });
    const contextPanel = document.querySelector<HTMLElement>('.context-panel');

    fireEvent.click(trigger);
    expect(contextPanel?.hasAttribute('inert')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть окно' }));
    expect(document.activeElement).not.toBe(trigger);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(contextPanel?.hasAttribute('inert')).toBe(false);
  });

  it('isolates the thread panel underneath the promotion modal', () => {
    const root = message();
    mocks.useWorkspace.mockReturnValue(
      workspace({
        messages: [root],
        activeThreadId: ids.root,
        thread: { root, replies: [], nextCursor: null },
      }),
    );
    render(<App />);
    const threadPanel = screen.getByLabelText('Тред');

    fireEvent.click(within(threadPanel).getByRole('button', { name: /В контекст/ }));
    expect(threadPanel.hasAttribute('inert')).toBe(true);
  });

  it('restores focus after a modal thread has committed its close', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const root = message();
    const openThread = vi.fn().mockResolvedValue(undefined);
    const closeThread = vi.fn();
    mocks.useWorkspace.mockReturnValue(workspace({ messages: [root], openThread, closeThread }));
    const view = render(<App />);
    const trigger = screen.getByRole('button', { name: 'Ответить' });
    fireEvent.click(trigger);

    mocks.useWorkspace.mockReturnValue(
      workspace({
        messages: [root],
        activeThreadId: ids.root,
        thread: { root, replies: [], nextCursor: null },
        openThread,
        closeThread,
      }),
    );
    view.rerender(<App />);
    const panel = screen.getByLabelText('Тред');
    fireEvent.click(within(panel).getByRole('button', { name: 'Закрыть тред' }));

    mocks.useWorkspace.mockReturnValue(workspace({ messages: [root], openThread, closeThread }));
    view.rerender(<App />);
    expect(document.activeElement).not.toBe(trigger);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('does not submit during IME composition and preserves code whitespace', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mocks.useWorkspace.mockReturnValue(workspace({ sendMessage }));
    render(<App />);
    const composer = screen.getByPlaceholderText('Сообщение в #Backend');
    const code = '  const value = 1;\n';

    fireEvent.click(screen.getByRole('button', { name: 'Режим кода' }));
    fireEvent.change(composer, { target: { value: code } });
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', isComposing: true });
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', isComposing: false });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(code, true));
  });

  it('offers Reply with zero replies and renders an interactive thread panel', async () => {
    const root = message();
    const reply = message({
      id: ids.reply,
      threadRootId: ids.root,
      sequence: 3,
      author: { ...message().author, id: ids.other, displayName: 'Марина Орлова' },
      blocks: [{ type: 'text', text: 'Ответ в треде' }],
    });
    const openThread = vi.fn().mockResolvedValue(undefined);
    const closeThread = vi.fn();
    const loadMoreReplies = vi.fn().mockResolvedValue(undefined);
    const sendReply = vi.fn().mockResolvedValue(undefined);
    const view = render(<App />);
    mocks.useWorkspace.mockReturnValue(workspace({ messages: [root], openThread }));
    view.rerender(<App />);

    fireEvent.click(screen.getByRole('button', { name: /Ответить/ }));
    await waitFor(() => expect(openThread).toHaveBeenCalledWith(ids.root));

    mocks.useWorkspace.mockReturnValue(
      workspace({
        messages: [root],
        activeThreadId: ids.root,
        thread: { root, replies: [reply], nextCursor: 'next page' },
        closeThread,
        loadMoreReplies,
        sendReply,
      }),
    );
    view.rerender(<App />);
    const panel = screen.getByLabelText('Тред');
    expect(within(panel).getByText('Ответ в треде')).toBeTruthy();
    fireEvent.change(within(panel).getByPlaceholderText('Ответить в треде'), {
      target: { value: 'Ещё один ответ' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(sendReply).toHaveBeenCalledWith('Ещё один ответ', false));
    fireEvent.click(within(panel).getByRole('button', { name: /Загрузить ещё/ }));
    await waitFor(() => expect(loadMoreReplies).toHaveBeenCalledOnce());
    fireEvent.click(within(panel).getByRole('button', { name: 'Закрыть тред' }));
    expect(closeThread).toHaveBeenCalledOnce();
  });

  it('keeps the initial unread boundary visible after opening a channel', () => {
    mocks.useWorkspace.mockReturnValue(workspace({ messages: [message({ sequence: 2 })] }));
    render(<App />);
    expect(screen.getByText('Новые сообщения')).toBeTruthy();
  });
});
