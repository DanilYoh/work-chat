import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Bookmark,
  Bot,
  Braces,
  Check,
  ChevronDown,
  CircleHelp,
  Code2,
  Edit3,
  Hash,
  Headphones,
  Inbox,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  MessageSquareText,
  MoreHorizontal,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings,
  SmilePlus,
  Sparkles,
  Trash2,
  Undo2,
  Users,
  Video,
  Volume2,
  X,
} from 'lucide-react';
import type { Message, MessageBlock, MessageThread, WorkItem } from '@work-chat/contracts';
import { useWorkspace } from './useWorkspace.js';

const itemLabels: Record<WorkItem['type'], string> = {
  decision: 'Решение',
  action: 'Действие',
  incident: 'Инцидент',
  release: 'Релиз',
  code_change: 'Изменение кода',
};

const quickReactions = ['👍', '❤️', '🎉', '👀', '🚀', '✅'];

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function Avatar({ name, online = false }: { name: string; online?: boolean }) {
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('');
  return (
    <span className="avatar">
      {initials}
      {online && <i />}
    </span>
  );
}

interface MessageRowProps {
  message: Message;
  currentUserId: string;
  inThread?: boolean;
  onPromote: (message: Message, trigger?: HTMLButtonElement) => void;
  onEdit: (messageId: string, blocks: MessageBlock[], expectedRevision: number) => Promise<void>;
  onDelete: (messageId: string, expectedRevision: number) => Promise<void>;
  onToggleReaction: (messageId: string, emoji: string, active: boolean) => Promise<void>;
  onOpenThread: (messageId: string, trigger?: HTMLButtonElement) => Promise<void>;
}

function replyLabel(count: number) {
  if (count === 0) return 'Ответить';
  const mod10 = count % 10;
  const mod100 = count % 100;
  const noun =
    mod10 === 1 && mod100 !== 11
      ? 'ответ'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'ответа'
        : 'ответов';
  return `${count} ${noun}`;
}

function MessageRow({
  message,
  currentUserId,
  inThread = false,
  onPromote,
  onEdit,
  onDelete,
  onToggleReaction,
  onOpenThread,
}: MessageRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MessageBlock[]>(message.blocks);
  const [editRevision, setEditRevision] = useState(message.revision);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const time = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(message.createdAt),
  );
  const ownMessage = message.author.id === currentUserId;
  const deleted = Boolean(message.deletedAt);
  const invalidDraft = draft.some(
    (block) => (block.type === 'text' ? block.text : block.code).trim().length === 0,
  );

  useEffect(() => {
    if (!editing) {
      setDraft(message.blocks);
      setEditRevision(message.revision);
    }
  }, [editing, message.blocks, message.revision]);

  async function runAction(action: () => Promise<void>) {
    setPending(true);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие');
      return false;
    } finally {
      setPending(false);
    }
  }

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (invalidDraft || pending) return;
    const saved = await runAction(() => onEdit(message.id, draft, editRevision));
    if (saved) setEditing(false);
  }

  async function confirmDelete() {
    if (!window.confirm('Удалить сообщение? Это действие нельзя отменить.')) return;
    await runAction(() => onDelete(message.id, message.revision));
  }

  function changeBlock(index: number, value: string) {
    setDraft((current) =>
      current.map((block, blockIndex) => {
        if (blockIndex !== index) return block;
        return block.type === 'code' ? { ...block, code: value } : { ...block, text: value };
      }),
    );
  }

  return (
    <article
      className={`message-row ${deleted ? 'deleted' : ''}`}
      data-message-id={message.id}
      data-sequence={message.sequence}
    >
      <Avatar name={message.author.displayName} online={message.author.status === 'online'} />
      <div className="message-content">
        <div className="message-meta">
          <strong>{message.author.displayName}</strong>
          <time dateTime={message.createdAt}>{time}</time>
          {message.editedAt && !deleted && (
            <span className="edited-label" title={new Date(message.editedAt).toLocaleString('ru')}>
              изменено
            </span>
          )}
        </div>

        {deleted ? (
          <p className="message-tombstone">
            <Trash2 size={13} /> Сообщение удалено
          </p>
        ) : editing ? (
          <form
            className="message-editor"
            onSubmit={(event) => {
              void submitEdit(event);
            }}
          >
            {draft.map((block, index) => (
              <label key={index}>
                <span>
                  {block.type === 'code' ? `Код, блок ${index + 1}` : `Текст, блок ${index + 1}`}
                </span>
                <textarea
                  className={block.type === 'code' ? 'code-input' : ''}
                  value={block.type === 'code' ? block.code : block.text}
                  onChange={(event) => changeBlock(index, event.target.value)}
                  rows={block.type === 'code' ? 5 : 2}
                  autoFocus={index === 0}
                />
              </label>
            ))}
            <div className="editor-actions">
              <button type="submit" className="primary" disabled={invalidDraft || pending}>
                {pending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{' '}
                Сохранить
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setEditing(false);
                  setActionError(null);
                }}
              >
                <Undo2 size={14} /> Отмена
              </button>
            </div>
          </form>
        ) : (
          message.blocks.map((block, index) =>
            block.type === 'code' ? (
              <pre key={index}>
                <code>{block.code}</code>
              </pre>
            ) : (
              <p key={index}>{block.text}</p>
            ),
          )
        )}

        {!editing && (
          <div className="message-actions">
            {!deleted &&
              Object.entries(message.reactions).map(([emoji, users]) => {
                const active = users.includes(currentUserId);
                return (
                  <button
                    type="button"
                    key={emoji}
                    className={`reaction ${active ? 'active' : ''}`}
                    aria-pressed={active}
                    aria-label={`${active ? 'Убрать' : 'Добавить'} реакцию ${emoji}`}
                    disabled={pending}
                    onClick={() => {
                      void runAction(() => onToggleReaction(message.id, emoji, active));
                    }}
                  >
                    {emoji} {users.length}
                  </button>
                );
              })}
            {!deleted && (
              <div
                className="reaction-picker"
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && pickerOpen) {
                    event.stopPropagation();
                    setPickerOpen(false);
                    event.currentTarget
                      .querySelector<HTMLButtonElement>(':scope > button')
                      ?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  aria-label="Добавить реакцию"
                  aria-expanded={pickerOpen}
                  disabled={pending}
                  onClick={() => setPickerOpen((open) => !open)}
                >
                  <SmilePlus size={13} />
                </button>
                {pickerOpen && (
                  <div className="reaction-menu" role="group" aria-label="Быстрые реакции">
                    {quickReactions.map((emoji) => {
                      const active = message.reactions[emoji]?.includes(currentUserId) ?? false;
                      return (
                        <button
                          type="button"
                          key={emoji}
                          aria-label={`${active ? 'Убрать' : 'Добавить'} реакцию ${emoji}`}
                          onClick={() => {
                            setPickerOpen(false);
                            void runAction(() => onToggleReaction(message.id, emoji, active));
                          }}
                        >
                          {emoji}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!inThread && (
              <button
                type="button"
                onClick={(event) => {
                  void runAction(() => onOpenThread(message.id, event.currentTarget));
                }}
              >
                <MessageCircle size={13} /> {replyLabel(message.replyCount)}
              </button>
            )}
            {!deleted && (
              <button type="button" onClick={(event) => onPromote(message, event.currentTarget)}>
                <Sparkles size={13} /> В контекст
              </button>
            )}
            {!deleted && ownMessage && (
              <>
                <button
                  type="button"
                  aria-label="Изменить сообщение"
                  disabled={pending}
                  onClick={() => {
                    setDraft(message.blocks);
                    setEditRevision(message.revision);
                    setEditing(true);
                    setActionError(null);
                  }}
                >
                  <Edit3 size={13} />
                </button>
                <button
                  type="button"
                  className="danger"
                  aria-label="Удалить сообщение"
                  disabled={pending}
                  onClick={() => {
                    void confirmDelete();
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </div>
        )}
        {actionError && (
          <p className="message-action-error" role="alert">
            {actionError}
          </p>
        )}
      </div>
    </article>
  );
}

interface ComposerProps {
  placeholder: string;
  onSend: (text: string, code: boolean) => Promise<void>;
  disabled?: boolean;
  autoFocus?: boolean;
}

function Composer({ placeholder, onSend, disabled = false, autoFocus = false }: ComposerProps) {
  const [text, setText] = useState('');
  const [codeMode, setCodeMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || sending || disabled) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(codeMode ? text : text.trim(), codeMode);
      setText('');
      setCodeMode(false);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Не удалось отправить сообщение');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="composer-tools">
          <button type="button" disabled aria-label="Добавить">
            <Plus size={18} />
          </button>
          <button type="button" disabled aria-label="Прикрепить файл">
            <Paperclip size={17} />
          </button>
          <button
            type="button"
            aria-label="Режим кода"
            disabled={disabled}
            className={codeMode ? 'active' : ''}
            onClick={() => setCodeMode(!codeMode)}
          >
            <Code2 size={17} />
          </button>
        </div>
        <textarea
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          rows={1}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          className="send-button"
          disabled={!text.trim() || sending || disabled}
          aria-label="Отправить"
        >
          {sending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
        </button>
      </form>
      {sendError && (
        <p className="composer-error" role="alert">
          {sendError}
        </p>
      )}
    </div>
  );
}

interface ThreadPanelProps extends Pick<
  MessageRowProps,
  'currentUserId' | 'onPromote' | 'onEdit' | 'onDelete' | 'onToggleReaction' | 'onOpenThread'
> {
  thread: MessageThread | null;
  loading: boolean;
  error: string | null;
  modal: boolean;
  inert?: boolean;
  onClose: () => void;
  onLoadMore: () => Promise<void>;
  onReply: (text: string, code: boolean) => Promise<void>;
}

function ThreadPanel({
  thread,
  loading,
  error,
  modal,
  inert = false,
  onClose,
  onLoadMore,
  onReply,
  ...messageActions
}: ThreadPanelProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (modal) closeButtonRef.current?.focus();
  }, [modal]);

  return (
    <aside
      className="thread-panel"
      role="dialog"
      aria-modal={modal || undefined}
      aria-labelledby="thread-title"
      inert={inert || undefined}
      onKeyDown={modal ? trapDialogFocus : undefined}
    >
      <header className="thread-header">
        <div>
          <MessageCircle size={17} />
          <strong id="thread-title">Тред</strong>
          {thread && <span>{thread.root.replyCount}</span>}
        </div>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Закрыть тред">
          <X size={18} />
        </button>
      </header>
      <div className="thread-messages">
        {loading && !thread && (
          <div className="thread-state">
            <LoaderCircle className="spin" />
            <span>Загружаем обсуждение…</span>
          </div>
        )}
        {error && !thread && (
          <div className="thread-state error">
            <CircleHelp />
            <span>{error}</span>
          </div>
        )}
        {thread && (
          <>
            <div className="thread-root">
              <MessageRow message={thread.root} inThread {...messageActions} />
            </div>
            <div className="thread-divider">
              <span>{replyLabel(thread.root.replyCount)}</span>
            </div>
            {thread.replies.map((reply) => (
              <MessageRow key={reply.id} message={reply} inThread {...messageActions} />
            ))}
            {!loading && thread.replies.length === 0 && (
              <div className="thread-empty">Ответов пока нет. Начните обсуждение.</div>
            )}
            {thread.nextCursor && (
              <button
                type="button"
                className="load-more"
                disabled={loading}
                onClick={() => {
                  void onLoadMore();
                }}
              >
                {loading ? <LoaderCircle className="spin" size={14} /> : null} Загрузить ещё
              </button>
            )}
            {error && (
              <p className="thread-inline-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
      {thread && (
        <Composer
          key={thread.root.id}
          placeholder={
            thread.root.deletedAt ? 'Нельзя ответить на удалённое сообщение' : 'Ответить в треде'
          }
          disabled={Boolean(thread.root.deletedAt)}
          onSend={onReply}
        />
      )}
    </aside>
  );
}

export function App() {
  const workspace = useWorkspace();
  const [query, setQuery] = useState('');
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [promotePending, setPromotePending] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [unreadBoundary, setUnreadBoundary] = useState<{
    channelId: string;
    sequence: number;
  } | null>(null);
  const threadTriggerRef = useRef<HTMLButtonElement | null>(null);
  const promoteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusRestoreTimerRef = useRef<number | null>(null);
  const threadModal = useMediaQuery('(max-width: 1180px)');

  useEffect(
    () => () => {
      if (focusRestoreTimerRef.current !== null) {
        window.clearTimeout(focusRestoreTimerRef.current);
      }
    },
    [],
  );

  function restoreFocusAfterCommit(target: HTMLButtonElement | null) {
    if (!target) return;
    if (focusRestoreTimerRef.current !== null) {
      window.clearTimeout(focusRestoreTimerRef.current);
    }
    focusRestoreTimerRef.current = window.setTimeout(() => {
      focusRestoreTimerRef.current = null;
      if (target.isConnected) target.focus();
    }, 0);
  }

  function closeThread() {
    workspace.closeThread();
    restoreFocusAfterCommit(threadTriggerRef.current);
  }

  function openPromotion(message: Message, trigger?: HTMLButtonElement) {
    promoteTriggerRef.current = trigger ?? null;
    setPromoteError(null);
    setPromotingId(message.id);
  }

  function closePromotion() {
    if (promotePending) return;
    setPromotingId(null);
    setPromoteError(null);
    restoreFocusAfterCommit(promoteTriggerRef.current);
  }

  const timeline = useMemo(
    () =>
      workspace.messages
        .filter((message) => message.threadRootId === null)
        .filter(
          (message) =>
            !query ||
            (!message.deletedAt &&
              message.blocks.some((block) =>
                (block.type === 'text' ? block.text : block.code)
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )),
        ),
    [query, workspace.messages],
  );

  useEffect(() => {
    const channel = workspace.activeChannel;
    setUnreadBoundary(
      channel && channel.unreadCount > 0
        ? { channelId: channel.id, sequence: channel.lastReadSequence }
        : null,
    );
    setQuery('');
  }, [workspace.activeChannelId]);

  useEffect(() => {
    if (!workspace.activeThreadId && !promotingId) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (promotingId) closePromotion();
      else closeThread();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [promotingId, promotePending, workspace.activeThreadId, workspace.closeThread]);

  if (!workspace.bootstrap) {
    if (workspace.error) {
      return (
        <div className="splash error-state">
          <CircleHelp />
          <strong>API недоступен</strong>
          <span>{workspace.error}</span>
        </div>
      );
    }
    return (
      <div className="splash">
        <div className="brand-mark">W</div>
        <span>Собираем рабочий контекст…</span>
      </div>
    );
  }

  const data = workspace.bootstrap;
  const sourceText = (message: Message) =>
    message.deletedAt
      ? ''
      : message.blocks.map((block) => (block.type === 'text' ? block.text : block.code)).join(' ');
  const threadMessages = workspace.thread
    ? [workspace.thread.root, ...workspace.thread.replies]
    : [];
  const promoting =
    [...workspace.messages, ...threadMessages].find(
      (message) => message.id === promotingId && !message.deletedAt,
    ) ?? null;
  const promotionOpen = Boolean(promoting);
  const backgroundInert = promotionOpen || (threadModal && Boolean(workspace.activeThreadId));
  const firstUnreadId =
    unreadBoundary?.channelId === workspace.activeChannelId
      ? timeline.find((message) => message.sequence > unreadBoundary.sequence)?.id
      : undefined;
  const messageActions = {
    currentUserId: data.currentUser.id,
    onPromote: openPromotion,
    onEdit: workspace.editMessage,
    onDelete: workspace.deleteMessage,
    onToggleReaction: workspace.toggleReaction,
    onOpenThread: (messageId: string, trigger?: HTMLButtonElement) => {
      threadTriggerRef.current = trigger ?? null;
      return workspace.openThread(messageId);
    },
  };

  async function submitPromotion(type: WorkItem['type']) {
    if (!promoting || promotePending) return;
    setPromotePending(true);
    setPromoteError(null);
    try {
      await workspace.promote(promoting.id, type, sourceText(promoting).slice(0, 120));
      setPromotingId(null);
      restoreFocusAfterCommit(promoteTriggerRef.current);
    } catch (cause) {
      setPromoteError(
        cause instanceof Error ? cause.message : 'Не удалось добавить сообщение в контекст',
      );
    } finally {
      setPromotePending(false);
    }
  }

  return (
    <main className={`app-shell ${workspace.activeThreadId ? 'thread-open' : ''}`}>
      <aside className={`rail ${mobileNav ? 'open' : ''}`} inert={backgroundInert || undefined}>
        <div className="brand-mark">W</div>
        <nav>
          <button className="active">
            <MessageSquareText />
            <span>Чаты</span>
          </button>
          <button>
            <Inbox />
            <span>Inbox</span>
            <b>4</b>
          </button>
          <button>
            <Bookmark />
            <span>Сохранено</span>
          </button>
          <button>
            <LayoutGrid />
            <span>Контекст</span>
          </button>
        </nav>
        <div className="rail-bottom">
          <button>
            <CircleHelp />
          </button>
          <button>
            <Settings />
          </button>
          <Avatar name={data.currentUser.displayName} online />
        </div>
      </aside>

      <aside className={`sidebar ${mobileNav ? 'open' : ''}`} inert={backgroundInert || undefined}>
        <header>
          <div>
            <small>ОРГАНИЗАЦИЯ</small>
            <strong>{data.organization.name}</strong>
          </div>
          <button>
            <ChevronDown size={16} />
          </button>
          <button
            className="mobile-close"
            aria-label="Закрыть навигацию"
            onClick={() => setMobileNav(false)}
          >
            <X />
          </button>
        </header>
        <div className="quick-search">
          <Search size={15} />
          <span>Найти</span>
          <kbd>⌘ K</kbd>
        </div>
        <section>
          <div className="section-title">
            <span>Пространства</span>
            <button>
              <Plus size={15} />
            </button>
          </div>
          {data.spaces.map((space) => (
            <div key={space.id}>
              <div className="space-name">
                <ChevronDown size={14} />
                {space.name}
              </div>
              {space.channels.map((channel) => (
                <button
                  className={`channel-link ${workspace.activeChannelId === channel.id ? 'active' : ''}`}
                  key={channel.id}
                  onClick={() => {
                    workspace.setActiveChannelId(channel.id);
                    setMobileNav(false);
                  }}
                >
                  {channel.kind === 'private' ? <LockKeyhole size={14} /> : <Hash size={15} />}
                  <span>{channel.name}</span>
                  {channel.unreadCount > 0 && <b>{channel.unreadCount}</b>}
                </button>
              ))}
            </div>
          ))}
        </section>
        <section>
          <div className="section-title">
            <span>Личные сообщения</span>
            <button>
              <Plus size={15} />
            </button>
          </div>
          <button className="channel-link">
            <span className="presence" />
            Марина Орлова
          </button>
          <button className="channel-link">
            <span className="presence away" />
            Илья Морозов
          </button>
        </section>
        <button className="sidebar-footer">
          <Bot size={17} />
          <span>Подключить интеграцию</span>
          <Plus size={15} />
        </button>
      </aside>

      <section className="conversation" inert={backgroundInert || undefined}>
        <header className="conversation-header">
          <button
            className="mobile-menu"
            aria-label="Открыть навигацию"
            aria-expanded={mobileNav}
            onClick={() => setMobileNav(true)}
          >
            <Hash />
          </button>
          <div>
            <h1>
              <Hash size={19} />
              {workspace.activeChannel?.name}
            </h1>
            <p>{workspace.activeChannel?.description}</p>
          </div>
          <div className="header-actions">
            <span className={`connection ${workspace.realtime}`}>
              <i />
              {workspace.realtime === 'online' ? 'В сети' : 'Синхронизация'}
            </span>
            <button>
              <Users size={18} />
              <span>12</span>
            </button>
            <button>
              <Headphones size={18} />
            </button>
            <button disabled title="Видео появится после GA">
              <Video size={18} />
            </button>
            <button>
              <MoreHorizontal />
            </button>
          </div>
        </header>
        <div className="search-row">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск в канале"
          />
          {query && (
            <button onClick={() => setQuery('')}>
              <X size={15} />
            </button>
          )}
        </div>
        <div className="messages">
          <div className="channel-intro">
            <div className="channel-icon">
              <Braces />
            </div>
            <h2>#{workspace.activeChannel?.name}</h2>
            <p>{workspace.activeChannel?.description}</p>
            <div>
              <span>
                <Users size={14} /> 12 участников
              </span>
              <span>
                <Volume2 size={14} /> Уведомления: важные
              </span>
            </div>
          </div>
          <div className="date-divider">
            <span>Сегодня</span>
          </div>
          {workspace.messageCursor && !workspace.error && (
            <button
              type="button"
              className="load-more timeline-load-more"
              disabled={workspace.messagesLoadingMore}
              onClick={() => {
                void workspace.loadMoreMessages();
              }}
            >
              {workspace.messagesLoadingMore ? <LoaderCircle className="spin" size={14} /> : null}
              Загрузить предыдущие сообщения
            </button>
          )}
          {timeline.map((message) => (
            <Fragment key={message.id}>
              {message.id === firstUnreadId && (
                <div className="unread-divider">
                  <span>Новые сообщения</span>
                </div>
              )}
              <MessageRow message={message} {...messageActions} />
            </Fragment>
          ))}
          {workspace.error && (
            <div className="channel-error" role="alert">
              <CircleHelp size={20} />
              <span>{workspace.error}</span>
              <button type="button" onClick={workspace.reloadChannel}>
                Повторить
              </button>
            </div>
          )}
          {!workspace.error && !workspace.loading && timeline.length === 0 && (
            <div className="empty">Здесь пока тихо. Начните обсуждение.</div>
          )}
        </div>
        <Composer
          placeholder={`Сообщение в #${workspace.activeChannel?.name ?? ''}`}
          onSend={workspace.sendMessage}
          disabled={workspace.loading || Boolean(workspace.error)}
        />
      </section>

      {workspace.activeThreadId ? (
        <>
          <button
            type="button"
            className="thread-backdrop"
            aria-label="Закрыть тред"
            inert={promotionOpen || undefined}
            onClick={closeThread}
          />
          <ThreadPanel
            thread={workspace.thread}
            loading={workspace.threadLoading}
            error={workspace.threadError}
            modal={threadModal}
            inert={promotionOpen}
            onClose={closeThread}
            onLoadMore={workspace.loadMoreReplies}
            onReply={workspace.sendReply}
            {...messageActions}
          />
        </>
      ) : (
        <aside className="context-panel" inert={promotionOpen || undefined}>
          <header>
            <div>
              <Sparkles size={17} />
              <strong>Рабочий контекст</strong>
            </div>
            <button>
              <MoreHorizontal />
            </button>
          </header>
          <div className="context-summary">
            <span>Открыто</span>
            <strong>{workspace.workItems.filter((item) => item.status === 'open').length}</strong>
            <small>объекта в канале</small>
          </div>
          <div className="context-list">
            {workspace.workItems.map((item) => (
              <article key={item.id} className={`work-item ${item.type}`}>
                <div>
                  <span>{itemLabels[item.type]}</span>
                  {item.severity && <b>{item.severity.toUpperCase()}</b>}
                </div>
                <strong>{item.title}</strong>
                <small>Источник: сообщение в #{workspace.activeChannel?.name}</small>
              </article>
            ))}
            {workspace.workItems.length === 0 && (
              <div className="context-empty">
                <Sparkles />
                <strong>Контекст появится здесь</strong>
                <p>Превращайте сообщения в решения, действия, инциденты и релизы.</p>
              </div>
            )}
          </div>
        </aside>
      )}

      {promoting && (
        <div className="modal-backdrop" onMouseDown={closePromotion}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="promote-title"
            onKeyDown={trapDialogFocus}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <Sparkles />
                <div>
                  <strong id="promote-title">Добавить в контекст</strong>
                  <small>Связь с исходным сообщением сохранится</small>
                </div>
              </div>
              <button
                type="button"
                autoFocus
                disabled={promotePending}
                aria-label="Закрыть окно"
                onClick={closePromotion}
              >
                <X />
              </button>
            </header>
            <p className="quote">{sourceText(promoting).slice(0, 180)}</p>
            <div className="promote-grid">
              {(['decision', 'action', 'incident', 'release', 'code_change'] as const).map(
                (type) => (
                  <button
                    type="button"
                    disabled={promotePending}
                    key={type}
                    onClick={() => {
                      void submitPromotion(type);
                    }}
                  >
                    <span>
                      {type === 'incident'
                        ? '!'
                        : type === 'decision'
                          ? '✓'
                          : type === 'action'
                            ? '→'
                            : type === 'release'
                              ? '↗'
                              : '<>'}
                    </span>
                    <strong>{itemLabels[type]}</strong>
                  </button>
                ),
              )}
            </div>
            {promoteError && (
              <p className="modal-error" role="alert">
                {promoteError}
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
