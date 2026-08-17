import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  domainEventSchema,
  messageSchema,
  readStateSchema,
  workItemSchema,
  type BootstrapResponse,
  type Channel,
  type DomainEvent,
  type Message,
  type MessageBlock,
  type MessageThread,
  type ReadState,
  type WorkItem,
} from '@work-chat/contracts';
import { api, DEV_TENANT_ID, DEV_USER_ID, REALTIME_URL } from './api.js';

type MessageMergeMode = 'content' | 'reaction' | 'thread-root' | 'full';

function mergeMessage(current: Message, incoming: Message, mode: MessageMergeMode): Message {
  const incomingContentIsCurrent =
    incoming.revision > current.revision && !(current.deletedAt && !incoming.deletedAt);
  const base = incomingContentIsCurrent
    ? {
        ...current,
        blocks: incoming.blocks,
        revision: incoming.revision,
        editedAt: incoming.editedAt,
        deletedAt: incoming.deletedAt,
      }
    : current;

  if (mode === 'reaction') {
    return base.deletedAt ? { ...base, reactions: {} } : { ...base, reactions: incoming.reactions };
  }
  if (mode === 'thread-root') {
    return {
      ...base,
      reactions: base.deletedAt ? {} : current.reactions,
      replyCount: Math.max(current.replyCount, incoming.replyCount),
    };
  }
  if (mode === 'full') {
    return {
      ...base,
      reactions: base.deletedAt ? {} : current.reactions,
      replyCount: Math.max(current.replyCount, incoming.replyCount),
    };
  }
  return base.deletedAt ? { ...base, reactions: {} } : base;
}

function upsertMessage(
  items: Message[],
  incoming: Message,
  mode: MessageMergeMode,
  insert: boolean,
) {
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index === -1)
    return insert
      ? [...items, incoming].sort((left, right) => left.sequence - right.sequence)
      : items;
  const merged = mergeMessage(items[index]!, incoming, mode);
  if (merged === items[index]) return items;
  return items.map((item, itemIndex) => (itemIndex === index ? merged : item));
}

function findChannel(data: BootstrapResponse | null, channelId: string | null): Channel | null {
  if (!data || !channelId) return null;
  return (
    data.spaces.flatMap((space) => space.channels).find((channel) => channel.id === channelId) ??
    data.directMessages.find((channel) => channel.id === channelId) ??
    null
  );
}

export function useWorkspace() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [thread, setThread] = useState<MessageThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channelReloadToken, setChannelReloadToken] = useState(0);
  const [realtime, setRealtime] = useState<'connecting' | 'online' | 'syncing'>('connecting');
  const cursorRef = useRef<string | undefined>(undefined);
  const bootstrapRef = useRef<BootstrapResponse | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const seenEventIdsRef = useRef(new Set<string>());
  const eventCursorByAspectRef = useRef(new Map<string, number>());
  const knownReplyIdsRef = useRef(new Set<string>());
  const countedUnreadMessageIdsRef = useRef(new Set<string>());
  const threadRequestRef = useRef(0);
  const operationKeysRef = useRef(new Map<string, string>());
  const pendingEventsRef = useRef<DomainEvent[]>([]);
  const bootstrapReadyRef = useRef(false);

  useEffect(() => {
    bootstrapRef.current = bootstrap;
  }, [bootstrap]);
  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const updateChannel = useCallback((channelId: string, update: (channel: Channel) => Channel) => {
    setBootstrap((current) => {
      if (!current) return current;
      const next: BootstrapResponse = {
        ...current,
        spaces: current.spaces.map((space) => ({
          ...space,
          channels: space.channels.map((channel) =>
            channel.id === channelId ? update(channel) : channel,
          ),
        })),
        directMessages: current.directMessages.map((channel) =>
          channel.id === channelId ? update(channel) : channel,
        ),
      };
      bootstrapRef.current = next;
      return next;
    });
  }, []);

  const applyReadState = useCallback(
    (readState: ReadState, latestSequenceAtRequest?: number) => {
      updateChannel(readState.channelId, (channel) => {
        if (readState.lastReadSequence < channel.lastReadSequence) return channel;
        const newerMessageArrivedWhileReading =
          latestSequenceAtRequest !== undefined && channel.latestSequence > latestSequenceAtRequest;
        return {
          ...channel,
          lastReadSequence: readState.lastReadSequence,
          unreadCount: newerMessageArrivedWhileReading
            ? Math.max(channel.unreadCount, readState.unreadCount)
            : readState.unreadCount,
        };
      });
    },
    [updateChannel],
  );

  const markRead = useCallback(
    async (channelId: string, lastReadSequence: number) => {
      const channel = findChannel(bootstrapRef.current, channelId);
      if (!channel || lastReadSequence <= channel.lastReadSequence) return;
      const latestSequenceAtRequest = Math.max(channel.latestSequence, lastReadSequence);
      const readState = await api.markRead(channelId, { lastReadSequence });
      applyReadState(readState, latestSequenceAtRequest);
    },
    [applyReadState],
  );

  const runIdempotent = useCallback(
    async <T>(fingerprint: string, action: (key: string) => Promise<T>) => {
      let key = operationKeysRef.current.get(fingerprint);
      if (!key) {
        key = crypto.randomUUID();
        operationKeysRef.current.set(fingerprint, key);
      }
      const result = await action(key);
      operationKeysRef.current.delete(fingerprint);
      return result;
    },
    [],
  );

  const applyMainMessage = useCallback(
    (message: Message, mode: MessageMergeMode, insert = false) => {
      if (message.threadRootId !== null) return;
      setMessages((current) => upsertMessage(current, message, mode, insert));
    },
    [],
  );

  const applyThreadMessage = useCallback(
    (message: Message, mode: MessageMergeMode, insert = false) => {
      setThread((current) => {
        if (!current) return current;
        if (current.root.id === message.id)
          return { ...current, root: mergeMessage(current.root, message, mode) };
        if (message.threadRootId !== current.root.id) return current;
        return { ...current, replies: upsertMessage(current.replies, message, mode, insert) };
      });
    },
    [],
  );

  const applyMessageEverywhere = useCallback(
    (message: Message, mode: MessageMergeMode, insert = false) => {
      applyMainMessage(message, mode, insert);
      applyThreadMessage(message, mode, insert);
    },
    [applyMainMessage, applyThreadMessage],
  );

  const noteCreatedMessage = useCallback(
    (message: Message) => {
      updateChannel(message.channelId, (channel) => {
        if (message.sequence <= channel.latestSequence) return channel;
        const ownMessage = message.author.id === bootstrapRef.current?.currentUser.id;
        const countsAsUnread = !message.deletedAt && !ownMessage;
        if (countsAsUnread) countedUnreadMessageIdsRef.current.add(message.id);
        return {
          ...channel,
          latestSequence: message.sequence,
          unreadCount: channel.unreadCount + (countsAsUnread ? 1 : 0),
        };
      });
    },
    [updateChannel],
  );

  const noteDeletedMessage = useCallback(
    (message: Message) => {
      if (!countedUnreadMessageIdsRef.current.delete(message.id)) return;
      const currentUserId = bootstrapRef.current?.currentUser.id;
      updateChannel(message.channelId, (channel) => {
        if (message.sequence <= channel.lastReadSequence || message.author.id === currentUserId)
          return channel;
        return { ...channel, unreadCount: Math.max(0, channel.unreadCount - 1) };
      });
    },
    [updateChannel],
  );

  const rememberEvent = useCallback((event: DomainEvent) => {
    const seen = seenEventIdsRef.current;
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    if (seen.size > 2_000) {
      const oldest = seen.values().next().value as string | undefined;
      if (oldest) seen.delete(oldest);
    }
    return true;
  }, []);

  const acceptAspectCursor = useCallback((key: string, cursor: number) => {
    const cursors = eventCursorByAspectRef.current;
    const previous = cursors.get(key) ?? 0;
    if (cursor <= previous) return false;
    cursors.set(key, cursor);
    return true;
  }, []);

  const applyEvent = useCallback(
    (event: DomainEvent) => {
      if (!bootstrapReadyRef.current) {
        pendingEventsRef.current.push(event);
        return;
      }
      if (!rememberEvent(event)) return;

      if (event.type === 'message.created') {
        const parsedMessage = messageSchema.safeParse(event.payload.message);
        if (!parsedMessage.success) return;
        const message = parsedMessage.data;
        const advancesChannel =
          message.sequence >
          (findChannel(bootstrapRef.current, message.channelId)?.latestSequence ?? 0);
        noteCreatedMessage(message);

        if (message.threadRootId === null) {
          if (message.channelId === activeChannelId) {
            applyMainMessage(message, 'full', true);
            if (advancesChannel && !message.deletedAt) {
              void markRead(message.channelId, message.sequence).catch(() =>
                setRealtime('syncing'),
              );
            }
          }
          return;
        }

        const firstSeen = !knownReplyIdsRef.current.has(message.id);
        knownReplyIdsRef.current.add(message.id);
        if (activeThreadId === message.threadRootId) {
          applyThreadMessage(message, 'full', true);
          if (advancesChannel && !message.deletedAt) {
            void markRead(message.channelId, message.sequence).catch(() => setRealtime('syncing'));
          }
        }

        const parsedRoot = messageSchema.safeParse(event.payload.threadRoot);
        if (
          parsedRoot.success &&
          acceptAspectCursor(`thread:${parsedRoot.data.id}`, event.cursor)
        ) {
          applyMainMessage(parsedRoot.data, 'thread-root');
          applyThreadMessage(parsedRoot.data, 'thread-root');
        } else if (firstSeen && advancesChannel) {
          setMessages((current) =>
            current.map((item) =>
              item.id === message.threadRootId
                ? { ...item, replyCount: item.replyCount + 1 }
                : item,
            ),
          );
          setThread((current) =>
            current?.root.id === message.threadRootId
              ? { ...current, root: { ...current.root, replyCount: current.root.replyCount + 1 } }
              : current,
          );
        }
        return;
      }

      if (event.type === 'message.updated' || event.type === 'message.deleted') {
        const parsed = messageSchema.safeParse(event.payload.message);
        if (parsed.success && acceptAspectCursor(`content:${parsed.data.id}`, event.cursor)) {
          if (event.type === 'message.deleted') noteDeletedMessage(parsed.data);
          if (parsed.data.channelId === activeChannelId) {
            applyMainMessage(parsed.data, 'content', true);
          }
          applyThreadMessage(parsed.data, 'content', true);
        }
        return;
      }

      if (event.type === 'reaction.added' || event.type === 'reaction.removed') {
        const parsed = messageSchema.safeParse(event.payload.message);
        if (parsed.success && acceptAspectCursor(`reaction:${parsed.data.id}`, event.cursor)) {
          if (parsed.data.channelId === activeChannelId) {
            applyMainMessage(parsed.data, 'reaction', true);
          }
          applyThreadMessage(parsed.data, 'reaction', true);
        }
        return;
      }

      if (event.type === 'channel.read') {
        const parsed = readStateSchema.safeParse(event.payload.readState);
        if (parsed.success && acceptAspectCursor(`read:${parsed.data.channelId}`, event.cursor))
          applyReadState(parsed.data);
        return;
      }

      if (event.type === 'work_item.created') {
        const parsed = workItemSchema.safeParse(event.payload.workItem);
        if (parsed.success && parsed.data.channelId === activeChannelId) {
          setWorkItems((current) =>
            current.some((candidate) => candidate.id === parsed.data.id)
              ? current
              : [parsed.data, ...current],
          );
        }
      }
    },
    [
      acceptAspectCursor,
      activeChannelId,
      activeThreadId,
      applyMainMessage,
      applyMessageEverywhere,
      applyReadState,
      applyThreadMessage,
      markRead,
      noteCreatedMessage,
      noteDeletedMessage,
      rememberEvent,
    ],
  );
  const applyEventRef = useRef(applyEvent);
  useEffect(() => {
    applyEventRef.current = applyEvent;
  }, [applyEvent]);

  useEffect(() => {
    let cancelled = false;
    void api
      .bootstrap()
      .then((data) => {
        if (cancelled) return;
        bootstrapRef.current = data;
        setBootstrap(data);
        const initial =
          data.spaces
            .flatMap((space) => space.channels)
            .find((channel) => channel.slug === 'backend') ?? data.spaces[0]?.channels[0];
        setActiveChannelId(initial?.id ?? null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeChannelId) return;
    let cancelled = false;
    threadRequestRef.current += 1;
    setActiveThreadId(null);
    setThread(null);
    setThreadError(null);
    setMessages([]);
    setMessageCursor(null);
    setMessagesLoadingMore(false);
    setWorkItems([]);
    setLoading(true);
    setError(null);
    Promise.all([api.messages(activeChannelId), api.workItems(activeChannelId)])
      .then(([messagePage, items]) => {
        if (cancelled) return;
        const roots = messagePage.items.filter((message) => message.threadRootId === null);
        setMessages((current) =>
          roots.reduce(
            (merged, root) =>
              merged.some((candidate) => candidate.id === root.id)
                ? merged
                : upsertMessage(merged, root, 'full', true),
            current,
          ),
        );
        setWorkItems((current) =>
          items.reduce(
            (merged, item) =>
              merged.some((candidate) => candidate.id === item.id) ? merged : [...merged, item],
            current,
          ),
        );
        setMessageCursor(messagePage.nextCursor);
        const visibleSequence = roots.at(-1)?.sequence;
        if (visibleSequence !== undefined) {
          void markRead(activeChannelId, visibleSequence).catch(() => setRealtime('syncing'));
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChannelId, channelReloadToken, markRead]);

  useEffect(() => {
    if (!bootstrap) return;
    const pending = pendingEventsRef.current
      .splice(0)
      .sort((left, right) => left.cursor - right.cursor);
    bootstrapReadyRef.current = true;
    pending.forEach((event) => applyEventRef.current(event));
  }, [bootstrap]);

  useEffect(() => {
    const url = new URL(REALTIME_URL);
    url.searchParams.set('tenantId', DEV_TENANT_ID);
    url.searchParams.set('userId', DEV_USER_ID);
    const socket = new WebSocket(url);
    socket.onopen = () => setRealtime('online');
    socket.onclose = () => setRealtime('syncing');
    socket.onerror = () => setRealtime('syncing');
    socket.onmessage = (messageEvent) => {
      try {
        const frame = JSON.parse(String(messageEvent.data)) as { type: string; event?: unknown };
        const parsed = frame.type === 'event' ? domainEventSchema.safeParse(frame.event) : null;
        if (parsed?.success) applyEventRef.current(parsed.data);
      } catch {
        setRealtime('syncing');
      }
    };
    return () => socket.close();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api
        .sync(cursorRef.current)
        .then((page) => {
          page.items.forEach(applyEvent);
          if (page.nextCursor) cursorRef.current = page.nextCursor;
        })
        .catch(() => setRealtime('syncing'));
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [applyEvent]);

  const activeChannel = useMemo<Channel | null>(
    () => findChannel(bootstrap, activeChannelId),
    [activeChannelId, bootstrap],
  );

  const sendMessage = useCallback(
    async (text: string, codeMode = false) => {
      if (!activeChannelId) return;
      const blocks: MessageBlock[] = codeMode
        ? [{ type: 'code', code: text }]
        : [{ type: 'text', text }];
      const fingerprint = `message:create:${activeChannelId}:${JSON.stringify(blocks)}`;
      const message = await runIdempotent(fingerprint, (clientId) =>
        api.sendMessage(activeChannelId, { clientId, blocks }),
      );
      applyMainMessage(message, 'full', true);
      noteCreatedMessage(message);
    },
    [activeChannelId, applyMainMessage, noteCreatedMessage, runIdempotent],
  );

  const loadMoreMessages = useCallback(async () => {
    if (!activeChannelId || !messageCursor || messagesLoadingMore) return;
    const channelId = activeChannelId;
    const cursor = messageCursor;
    setMessagesLoadingMore(true);
    setError(null);
    try {
      const page = await api.messages(channelId, cursor);
      if (activeChannelIdRef.current !== channelId) return;
      const roots = page.items.filter((message) => message.threadRootId === null);
      setMessages((current) =>
        roots.reduce((merged, root) => upsertMessage(merged, root, 'full', true), current),
      );
      setMessageCursor(page.nextCursor);
    } catch (cause) {
      if (activeChannelIdRef.current === channelId) {
        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить сообщения');
      }
    } finally {
      if (activeChannelIdRef.current === channelId) setMessagesLoadingMore(false);
    }
  }, [activeChannelId, messageCursor, messagesLoadingMore]);

  const reloadChannel = useCallback(() => setChannelReloadToken((current) => current + 1), []);

  const editMessage = useCallback(
    async (messageId: string, blocks: MessageBlock[], expectedRevision: number) => {
      const fingerprint = `message:edit:${messageId}:${expectedRevision}:${JSON.stringify(blocks)}`;
      const message = await runIdempotent(fingerprint, (key) =>
        api.editMessage(messageId, { blocks, expectedRevision }, key),
      );
      applyMessageEverywhere(message, 'content');
    },
    [applyMessageEverywhere, runIdempotent],
  );

  const deleteMessage = useCallback(
    async (messageId: string, expectedRevision: number) => {
      const fingerprint = `message:delete:${messageId}:${expectedRevision}`;
      const message = await runIdempotent(fingerprint, (key) =>
        api.deleteMessage(messageId, { expectedRevision }, key),
      );
      applyMessageEverywhere(message, 'content');
    },
    [applyMessageEverywhere, runIdempotent],
  );

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string, active: boolean) => {
      const aspectKey = `reaction:${messageId}`;
      const cursorAtRequest = eventCursorByAspectRef.current.get(aspectKey) ?? 0;
      const message = active
        ? await api.removeReaction(messageId, { emoji })
        : await api.addReaction(messageId, { emoji });
      if ((eventCursorByAspectRef.current.get(aspectKey) ?? 0) !== cursorAtRequest) return;
      applyMessageEverywhere(message, 'reaction');
    },
    [applyMessageEverywhere],
  );

  const openThread = useCallback(
    async (rootId: string) => {
      const requestId = ++threadRequestRef.current;
      const localRoot = messagesRef.current.find((message) => message.id === rootId);
      setActiveThreadId(rootId);
      setThread(localRoot ? { root: localRoot, replies: [], nextCursor: null } : null);
      setThreadLoading(true);
      setThreadError(null);
      try {
        const result = await api.thread(rootId);
        if (requestId !== threadRequestRef.current) return;
        result.replies.forEach((reply) => knownReplyIdsRef.current.add(reply.id));
        setThread((current) =>
          current?.root.id === rootId
            ? {
                root: mergeMessage(current.root, result.root, 'thread-root'),
                replies: result.replies.reduce(
                  (merged, reply) =>
                    merged.some((candidate) => candidate.id === reply.id)
                      ? merged
                      : upsertMessage(merged, reply, 'full', true),
                  current.replies,
                ),
                nextCursor: result.nextCursor,
              }
            : {
                ...result,
                replies: [...result.replies].sort((left, right) => left.sequence - right.sequence),
              },
        );
        applyMainMessage(result.root, 'thread-root');
        const visibleSequence = result.replies.at(-1)?.sequence ?? result.root.sequence;
        void markRead(result.root.channelId, visibleSequence).catch(() => setRealtime('syncing'));
      } catch (cause) {
        if (requestId === threadRequestRef.current) {
          setThreadError(cause instanceof Error ? cause.message : 'Не удалось загрузить тред');
        }
        throw cause;
      } finally {
        if (requestId === threadRequestRef.current) setThreadLoading(false);
      }
    },
    [applyMainMessage, markRead],
  );

  const closeThread = useCallback(() => {
    threadRequestRef.current += 1;
    setActiveThreadId(null);
    setThread(null);
    setThreadLoading(false);
    setThreadError(null);
  }, []);

  const loadMoreReplies = useCallback(async () => {
    if (!thread?.nextCursor || threadLoading) return;
    const rootId = thread.root.id;
    const cursor = thread.nextCursor;
    const requestId = ++threadRequestRef.current;
    setThreadLoading(true);
    setThreadError(null);
    try {
      const result = await api.thread(rootId, cursor);
      if (requestId !== threadRequestRef.current || activeThreadId !== rootId) return;
      result.replies.forEach((reply) => knownReplyIdsRef.current.add(reply.id));
      setThread((current) =>
        current?.root.id === rootId
          ? {
              root: mergeMessage(current.root, result.root, 'full'),
              replies: result.replies.reduce(
                (items, reply) => upsertMessage(items, reply, 'full', true),
                current.replies,
              ),
              nextCursor: result.nextCursor,
            }
          : current,
      );
      applyMainMessage(result.root, 'thread-root');
      const visibleSequence = result.replies.at(-1)?.sequence;
      if (visibleSequence !== undefined) {
        await markRead(result.root.channelId, visibleSequence);
      }
    } catch (cause) {
      if (requestId === threadRequestRef.current) {
        setThreadError(cause instanceof Error ? cause.message : 'Не удалось загрузить ответы');
      }
    } finally {
      if (requestId === threadRequestRef.current) setThreadLoading(false);
    }
  }, [activeThreadId, applyMainMessage, markRead, thread, threadLoading]);

  const sendReply = useCallback(
    async (text: string, codeMode = false) => {
      if (!activeChannelId || !activeThreadId) return;
      const blocks: MessageBlock[] = codeMode
        ? [{ type: 'code', code: text }]
        : [{ type: 'text', text }];
      const fingerprint = `message:reply:${activeChannelId}:${activeThreadId}:${JSON.stringify(blocks)}`;
      const message = await runIdempotent(fingerprint, (clientId) =>
        api.sendMessage(activeChannelId, {
          clientId,
          threadRootId: activeThreadId,
          blocks,
        }),
      );
      const firstSeen = !knownReplyIdsRef.current.has(message.id);
      knownReplyIdsRef.current.add(message.id);
      applyThreadMessage(message, 'full', true);
      if (firstSeen) {
        setMessages((current) =>
          current.map((item) =>
            item.id === activeThreadId ? { ...item, replyCount: item.replyCount + 1 } : item,
          ),
        );
        setThread((current) =>
          current?.root.id === activeThreadId
            ? { ...current, root: { ...current.root, replyCount: current.root.replyCount + 1 } }
            : current,
        );
      }
      noteCreatedMessage(message);
    },
    [activeChannelId, activeThreadId, applyThreadMessage, noteCreatedMessage, runIdempotent],
  );

  const promote = useCallback(async (messageId: string, type: WorkItem['type'], title: string) => {
    const item = await api.createWorkItem(messageId, {
      type,
      title,
      severity: type === 'incident' ? 'sev2' : null,
      externalReferences: [],
    });
    setWorkItems((current) =>
      current.some((candidate) => candidate.id === item.id) ? current : [item, ...current],
    );
  }, []);

  return {
    bootstrap,
    activeChannel,
    activeChannelId,
    setActiveChannelId,
    messages,
    messageCursor,
    messagesLoadingMore,
    loadMoreMessages,
    reloadChannel,
    workItems,
    loading,
    error,
    realtime,
    sendMessage,
    promote,
    editMessage,
    deleteMessage,
    toggleReaction,
    activeThreadId,
    thread,
    threadLoading,
    threadError,
    openThread,
    closeThread,
    loadMoreReplies,
    sendReply,
  };
}
