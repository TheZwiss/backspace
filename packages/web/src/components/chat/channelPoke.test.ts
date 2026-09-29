import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ toast: vi.fn(), current: 'chat', status: 'online' }));
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: state.toast }) } }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => ({}) }, selectMyChosenStatus: () => state.status }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ currentChannelId: state.current }) } }));
vi.mock('../../stores/spaceStore', () => ({ useSpaceStore: { getState: () => ({ channelToSpaceMap: new Map([['chat', 'space']]) }) }, getChannelOrigin: () => '' }));
vi.mock('../../utils/identity', () => ({ isRegisteredSelfId: (id: string) => id === 'me' }));
import { useNotificationStore } from '../../stores/notificationStore';
import { receiveChannelPoke } from './channelPoke';
const event = { type: 'channel_poke', channelId: 'chat', userId: 'actor', targetUserId: 'target', username: 'Actor', targetUsername: 'Target' } as const;
beforeEach(() => { vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true }))); state.toast.mockClear(); state.current = 'chat'; state.status = 'online'; useNotificationStore.getState().reset(); });
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
describe('server-confirmed poke cue', () => {
  it('preserves the avatar animation without a toast', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    const animate = vi.fn(() => ({ onfinish: null }));
    vi.stubGlobal('Element', Element);
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    try {
      document.body.innerHTML = '<div data-poke-user="target"></div>';
      receiveChannelPoke('', event);
      expect(animate).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[data-poke-user]')).toHaveTextContent('👈');
      expect(state.toast).not.toHaveBeenCalled();
    } finally {
      Element.prototype.animate = originalAnimate;
    }
  });
  it('does not create a floating notification with reduced motion', () => {
    receiveChannelPoke('', event);
    expect(state.toast).not.toHaveBeenCalled();
  });
  it('does not interrupt unrelated channels or another origin', () => {
    receiveChannelPoke('https://other.example', event);
    state.current = 'other';
    receiveChannelPoke('', event);
    expect(state.toast).not.toHaveBeenCalled();
  });
  it('respects Do Not Disturb', () => {
    state.status = 'dnd';
    receiveChannelPoke('', event);
    expect(state.toast).not.toHaveBeenCalled();
  });
});
