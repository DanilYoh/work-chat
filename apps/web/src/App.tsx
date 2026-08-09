import { useMemo, useState, type FormEvent } from 'react';
import {
  Bookmark, Bot, Braces, ChevronDown, CircleHelp, Code2, Hash, Headphones,
  Inbox, LayoutGrid, LockKeyhole, MessageSquareText, MoreHorizontal, Paperclip,
  Plus, Search, Send, Settings, Sparkles, Users, Video, Volume2, X,
} from 'lucide-react';
import type { Message, WorkItem } from '@work-chat/contracts';
import { useWorkspace } from './useWorkspace.js';

const itemLabels: Record<WorkItem['type'], string> = {
  decision: 'Решение',
  action: 'Действие',
  incident: 'Инцидент',
  release: 'Релиз',
  code_change: 'Изменение кода',
};

function Avatar({ name, online = false }: { name: string; online?: boolean }) {
  const initials = name.split(' ').map((part) => part[0]).slice(0, 2).join('');
  return <span className="avatar">{initials}{online && <i />}</span>;
}

function MessageRow({ message, onPromote }: { message: Message; onPromote: (message: Message) => void }) {
  const time = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt));
  return (
    <article className="message-row">
      <Avatar name={message.author.displayName} online={message.author.status === 'online'} />
      <div className="message-content">
        <div className="message-meta"><strong>{message.author.displayName}</strong><time>{time}</time></div>
        {message.blocks.map((block, index) => block.type === 'code'
          ? <pre key={index}><code>{block.code}</code></pre>
          : <p key={index}>{block.text}</p>)}
        <div className="message-actions">
          {Object.entries(message.reactions).map(([emoji, users]) => <button key={emoji} className="reaction">{emoji} {users.length}</button>)}
          {message.replyCount > 0 && <button>{message.replyCount} ответа</button>}
          <button onClick={() => onPromote(message)}><Sparkles size={13} /> В контекст</button>
        </div>
      </div>
    </article>
  );
}

function Composer({ channelName, onSend }: { channelName: string; onSend: (text: string, code: boolean) => Promise<void> }) {
  const [text, setText] = useState('');
  const [codeMode, setCodeMode] = useState(false);
  const [sending, setSending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await onSend(text.trim(), codeMode);
      setText('');
      setCodeMode(false);
    } finally {
      setSending(false);
    }
  }
  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-tools">
        <button type="button"><Plus size={18} /></button>
        <button type="button"><Paperclip size={17} /></button>
        <button type="button" className={codeMode ? 'active' : ''} onClick={() => setCodeMode(!codeMode)}><Code2 size={17} /></button>
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={`Сообщение в #${channelName}`}
        rows={1}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <button className="send-button" disabled={!text.trim() || sending} aria-label="Отправить"><Send size={17} /></button>
    </form>
  );
}

export function App() {
  const workspace = useWorkspace();
  const [query, setQuery] = useState('');
  const [promoting, setPromoting] = useState<Message | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const filtered = useMemo(
    () => workspace.messages.filter((message) => !query || message.blocks.some((block) =>
      (block.type === 'text' ? block.text : block.code).toLowerCase().includes(query.toLowerCase()),
    )),
    [query, workspace.messages],
  );

  if (!workspace.bootstrap) {
    if (workspace.error) {
      return <div className="splash error-state"><CircleHelp /><strong>API недоступен</strong><span>{workspace.error}</span></div>;
    }
    return <div className="splash"><div className="brand-mark">W</div><span>Собираем рабочий контекст…</span></div>;
  }
  const data = workspace.bootstrap;
  const sourceText = (message: Message) => message.blocks
    .map((block) => block.type === 'text' ? block.text : block.code)
    .join(' ');

  return (
    <main className="app-shell">
      <aside className={`rail ${mobileNav ? 'open' : ''}`}>
        <div className="brand-mark">W</div>
        <nav>
          <button className="active"><MessageSquareText /><span>Чаты</span></button>
          <button><Inbox /><span>Inbox</span><b>4</b></button>
          <button><Bookmark /><span>Сохранено</span></button>
          <button><LayoutGrid /><span>Контекст</span></button>
        </nav>
        <div className="rail-bottom"><button><CircleHelp /></button><button><Settings /></button><Avatar name={data.currentUser.displayName} online /></div>
      </aside>

      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <header>
          <div><small>ОРГАНИЗАЦИЯ</small><strong>{data.organization.name}</strong></div>
          <button><ChevronDown size={16} /></button>
          <button className="mobile-close" onClick={() => setMobileNav(false)}><X /></button>
        </header>
        <div className="quick-search"><Search size={15} /><span>Найти</span><kbd>⌘ K</kbd></div>
        <section>
          <div className="section-title"><span>Пространства</span><button><Plus size={15} /></button></div>
          {data.spaces.map((space) => <div key={space.id}>
            <div className="space-name"><ChevronDown size={14} />{space.name}</div>
            {space.channels.map((channel) => <button
              className={`channel-link ${workspace.activeChannelId === channel.id ? 'active' : ''}`}
              key={channel.id}
              onClick={() => { workspace.setActiveChannelId(channel.id); setMobileNav(false); }}
            >
              {channel.kind === 'private' ? <LockKeyhole size={14} /> : <Hash size={15} />}
              <span>{channel.name}</span>{channel.unreadCount > 0 && <b>{channel.unreadCount}</b>}
            </button>)}
          </div>)}
        </section>
        <section>
          <div className="section-title"><span>Личные сообщения</span><button><Plus size={15} /></button></div>
          <button className="channel-link"><span className="presence" />Марина Орлова</button>
          <button className="channel-link"><span className="presence away" />Илья Морозов</button>
        </section>
        <button className="sidebar-footer"><Bot size={17} /><span>Подключить интеграцию</span><Plus size={15} /></button>
      </aside>

      <section className="conversation">
        <header className="conversation-header">
          <button className="mobile-menu" onClick={() => setMobileNav(true)}><Hash /></button>
          <div><h1><Hash size={19} />{workspace.activeChannel?.name}</h1><p>{workspace.activeChannel?.description}</p></div>
          <div className="header-actions">
            <span className={`connection ${workspace.realtime}`}><i />{workspace.realtime === 'online' ? 'В сети' : 'Синхронизация'}</span>
            <button><Users size={18} /><span>12</span></button>
            <button><Headphones size={18} /></button>
            <button disabled title="Видео появится после GA"><Video size={18} /></button>
            <button><MoreHorizontal /></button>
          </div>
        </header>
        <div className="search-row"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск в канале" />{query && <button onClick={() => setQuery('')}><X size={15} /></button>}</div>
        <div className="messages">
          <div className="channel-intro"><div className="channel-icon"><Braces /></div><h2>#{workspace.activeChannel?.name}</h2><p>{workspace.activeChannel?.description}</p><div><span><Users size={14} /> 12 участников</span><span><Volume2 size={14} /> Уведомления: важные</span></div></div>
          <div className="date-divider"><span>Сегодня</span></div>
          {filtered.map((message) => <MessageRow key={message.id} message={message} onPromote={setPromoting} />)}
          {!workspace.loading && filtered.length === 0 && <div className="empty">Здесь пока тихо. Начните обсуждение.</div>}
        </div>
        <Composer channelName={workspace.activeChannel?.name ?? ''} onSend={workspace.sendMessage} />
      </section>

      <aside className="context-panel">
        <header><div><Sparkles size={17} /><strong>Рабочий контекст</strong></div><button><MoreHorizontal /></button></header>
        <div className="context-summary"><span>Открыто</span><strong>{workspace.workItems.filter((item) => item.status === 'open').length}</strong><small>объекта в канале</small></div>
        <div className="context-list">
          {workspace.workItems.map((item) => <article key={item.id} className={`work-item ${item.type}`}><div><span>{itemLabels[item.type]}</span>{item.severity && <b>{item.severity.toUpperCase()}</b>}</div><strong>{item.title}</strong><small>Источник: сообщение в #{workspace.activeChannel?.name}</small></article>)}
          {workspace.workItems.length === 0 && <div className="context-empty"><Sparkles /><strong>Контекст появится здесь</strong><p>Превращайте сообщения в решения, действия, инциденты и релизы.</p></div>}
        </div>
      </aside>

      {promoting && <div className="modal-backdrop" onMouseDown={() => setPromoting(null)}>
        <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><Sparkles /><div><strong>Добавить в контекст</strong><small>Связь с исходным сообщением сохранится</small></div></div><button onClick={() => setPromoting(null)}><X /></button></header>
          <p className="quote">{sourceText(promoting).slice(0, 180)}</p>
          <div className="promote-grid">{(['decision', 'action', 'incident', 'release', 'code_change'] as const).map((type) => <button key={type} onClick={() => {
            void workspace.promote(promoting.id, type, sourceText(promoting).slice(0, 120));
            setPromoting(null);
          }}><span>{type === 'incident' ? '!' : type === 'decision' ? '✓' : type === 'action' ? '→' : type === 'release' ? '↗' : '<>'}</span><strong>{itemLabels[type]}</strong></button>)}</div>
        </section>
      </div>}
    </main>
  );
}
