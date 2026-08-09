import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

vi.mock('./useWorkspace.js', () => ({
  useWorkspace: () => ({
    bootstrap: {
      organization: { id: '11111111-1111-4111-8111-111111111111', name: 'Orbit Labs', slug: 'orbit-labs' },
      currentUser: {
        id: '22222222-2222-4222-8222-222222222222',
        displayName: 'Данил Соколов',
        email: 'danil@example.ru',
        avatarUrl: null,
        status: 'online',
      },
      spaces: [{
        id: '33333333-3333-4333-8333-333333333333', name: 'Platform', slug: 'platform',
        channels: [{
          id: '44444444-4444-4444-8444-444444444445',
          spaceId: '33333333-3333-4333-8333-333333333333',
          name: 'Backend', slug: 'backend', description: 'API и архитектура', kind: 'public', unreadCount: 0,
        }],
      }],
      directMessages: [],
    },
    activeChannel: {
      id: '44444444-4444-4444-8444-444444444445',
      spaceId: '33333333-3333-4333-8333-333333333333',
      name: 'Backend', slug: 'backend', description: 'API и архитектура', kind: 'public', unreadCount: 0,
    },
    activeChannelId: '44444444-4444-4444-8444-444444444445',
    setActiveChannelId: vi.fn(), messages: [], workItems: [], loading: false,
    error: null, realtime: 'online', sendMessage: vi.fn(), promote: vi.fn(),
  }),
}));

describe('workspace shell', () => {
  it('renders the organization, channel and context panel', () => {
    const view = render(<App />);
    expect(view.container.textContent).toContain('Orbit Labs');
    expect(view.container.textContent).toContain('Backend');
    expect(view.container.textContent).toContain('Рабочий контекст');
  });
});

