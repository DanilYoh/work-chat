import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BootstrapResponse, Channel, DomainEvent, Message, WorkItem } from '@work-chat/contracts';
import { api, DEV_TENANT_ID, DEV_USER_ID, REALTIME_URL } from './api.js';

export function useWorkspace() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [realtime, setRealtime] = useState<'connecting' | 'online' | 'syncing'>('connecting');
  const cursorRef = useRef<string | undefined>(undefined);

  const applyEvent = useCallback((event: DomainEvent) => {
    if (event.type === 'message.created') {
      const message = event.payload.message as Message;
      if (message.channelId === activeChannelId) {
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      }
    }
    if (event.type === 'work_item.created') {
      const item = event.payload.workItem as WorkItem;
      if (item.channelId === activeChannelId) {
        setWorkItems((current) => current.some((candidate) => candidate.id === item.id) ? current : [item, ...current]);
      }
    }
  }, [activeChannelId]);
  const applyEventRef = useRef(applyEvent);
  useEffect(() => { applyEventRef.current = applyEvent; }, [applyEvent]);

  useEffect(() => {
    let cancelled = false;
    void api.bootstrap()
      .then((data) => {
        if (cancelled) return;
        setBootstrap(data);
        const initial = data.spaces.flatMap((space) => space.channels).find((channel) => channel.slug === 'backend')
          ?? data.spaces[0]?.channels[0];
        setActiveChannelId(initial?.id ?? null);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!activeChannelId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([api.messages(activeChannelId), api.workItems(activeChannelId)])
      .then(([messagePage, items]) => {
        if (cancelled) return;
        setMessages(messagePage.items);
        setWorkItems(items);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
    return () => { cancelled = true; };
  }, [activeChannelId]);

  useEffect(() => {
    const url = new URL(REALTIME_URL);
    url.searchParams.set('tenantId', DEV_TENANT_ID);
    url.searchParams.set('userId', DEV_USER_ID);
    const socket = new WebSocket(url);
    socket.onopen = () => setRealtime('online');
    socket.onclose = () => setRealtime('syncing');
    socket.onerror = () => setRealtime('syncing');
    socket.onmessage = (messageEvent) => {
      const frame = JSON.parse(String(messageEvent.data)) as { type: string; event?: DomainEvent };
      if (frame.type === 'event' && frame.event) applyEventRef.current(frame.event);
    };
    return () => socket.close();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api.sync(cursorRef.current).then((page) => {
        page.items.forEach(applyEvent);
        if (page.nextCursor) cursorRef.current = page.nextCursor;
      }).catch(() => setRealtime('syncing'));
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [applyEvent]);

  const activeChannel = useMemo<Channel | null>(() => {
    return bootstrap?.spaces.flatMap((space) => space.channels).find((channel) => channel.id === activeChannelId)
      ?? bootstrap?.directMessages.find((channel) => channel.id === activeChannelId)
      ?? null;
  }, [activeChannelId, bootstrap]);

  const sendMessage = useCallback(async (text: string, codeMode = false) => {
    if (!activeChannelId) return;
    const message = await api.sendMessage(activeChannelId, {
      clientId: crypto.randomUUID(),
      blocks: codeMode ? [{ type: 'code', code: text }] : [{ type: 'text', text }],
    });
    setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
  }, [activeChannelId]);

  const promote = useCallback(async (messageId: string, type: WorkItem['type'], title: string) => {
    const item = await api.createWorkItem(messageId, {
      type,
      title,
      severity: type === 'incident' ? 'sev2' : null,
      externalReferences: [],
    });
    setWorkItems((current) => current.some((candidate) => candidate.id === item.id) ? current : [item, ...current]);
  }, []);

  return {
    bootstrap, activeChannel, activeChannelId, setActiveChannelId,
    messages, workItems, loading, error, realtime, sendMessage, promote,
  };
}
