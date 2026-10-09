import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ current: 'chat', status: 'online', muted: false, level: 'mentions' }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => ({}) }, selectMyChosenStatus: () => state.status, getMyUserIdForOrigin: () => 'me' }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ currentChannelId: state.current }) } }));
vi.mock('../../stores/spaceStore', () => ({ getChannelOrigin: () => '' }));
vi.mock('../../hooks/useNotificationSettings', () => ({ getChannelNotificationPolicy: () => state }));
import { receiveChannelPoke } from './channelPoke';
const event = { type: 'channel_poke', channelId: 'chat', userId: 'actor', targetUserId: 'target', username: 'Actor', targetUsername: 'Target' } as const;
const animate = vi.fn(() => ({ onfinish: null }));
const originalAnimate = Element.prototype.animate;
beforeEach(() => {
  Object.assign(state, { current: 'chat', status: 'online', muted: false, level: 'mentions' });
  animate.mockClear();
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  document.body.innerHTML = '<div data-poke-user="target"></div>';
});
afterEach(() => { document.body.replaceChildren(); Element.prototype.animate = originalAnimate; vi.unstubAllGlobals(); });
describe('server-confirmed poke cue', () => {
  it('animates the target and removes the finger when finished', () => {
    receiveChannelPoke('', event);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(document.body).toHaveTextContent('👈');
    const fingerAnimation = animate.mock.results[1]!.value as { onfinish: () => void };
    fingerAnimation.onfinish();
    expect(document.body).not.toHaveTextContent('👈');
  });
  it('does not animate reduced-motion, unrelated channels or origins', () => {
    receiveChannelPoke('https://other.example', event);
    state.current = 'other'; receiveChannelPoke('', event);
    state.current = 'chat'; vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    receiveChannelPoke('', event);
    expect(animate).not.toHaveBeenCalled();
  });
  it('respects DND, mute and suppression for recipients', () => {
    state.status = 'dnd'; receiveChannelPoke('', event);
    state.status = 'online'; state.muted = true; receiveChannelPoke('', event);
    state.muted = false; state.level = 'nothing'; receiveChannelPoke('', event);
    expect(animate).not.toHaveBeenCalled();
  });
});
