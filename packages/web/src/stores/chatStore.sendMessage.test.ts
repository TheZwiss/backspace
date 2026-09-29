import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';
vi.mock('../hooks/useWebSocket', () => ({ wsSend: vi.fn(), wsSendAll: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
const send = vi.fn();
vi.mock('../utils/crossStoreResolvers', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({ channels: { sendMessage: send } }),
}));
import { useAuthStore } from './authStore';
import { useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';
beforeEach(() => {
  send.mockReset();
  window.history.replaceState({}, '', '/channels/space/chat');
  useAuthStore.setState({ user: { id: 'me', username: 'Alice' } as User });
  useSpaceStore.setState({ dmChannels: [], channelToSpaceMap: new Map([['chat', 'space']]) });
  useChatStore.setState({ messages: new Map(), replyTo: null, detachedChannels: new Set() });
});
describe('chatStore text submission', () => {
  it('displays an optimistic message before a slow request completes', async () => {
    let finish!: () => void;
    send.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const sending = useChatStore.getState().sendMessage('chat', 'hello');
    expect(useChatStore.getState().messages.get('chat')).toEqual([
      expect.objectContaining({ content: 'hello', id: expect.stringMatching(/^temp_/) }),
    ]);
    finish();
    await sending;
  });
  it('removes the optimistic message and exposes rejection to the composer', async () => {
    send.mockRejectedValue(new Error('Offline'));
    await expect(useChatStore.getState().sendMessage('chat', 'hello')).rejects.toThrow('Offline');
    expect(useChatStore.getState().messages.get('chat') ?? []).toEqual([]);
  });
});


describe('passive channel system history', () => {
  it('stores and deduplicates pokes without scheduling sound or desktop notifications', () => {
    useChatStore.setState({ realtimeMessageEvents: [] });
    const message = { id: '123', channelId: 'chat', userId: 'other', type: 'system', content: JSON.stringify({ event: 'channel_poke' }), attachments: [] } as unknown as MessageWithUser;
    useChatStore.getState().addRealtimeMessage('chat', message);
    useChatStore.getState().addRealtimeMessage('chat', message);
    expect(useChatStore.getState().messages.get('chat')).toHaveLength(1);
    expect(useChatStore.getState().realtimeMessageEvents).toEqual([]);
  });
});
