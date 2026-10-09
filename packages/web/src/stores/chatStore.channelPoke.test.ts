import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageWithUser } from '@backspace/shared';
vi.mock('../hooks/useWebSocket', () => ({ wsSend: vi.fn(), wsSendAll: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
import { useChatStore } from './chatStore';
const message = { id: '123', channelId: 'chat', userId: 'other', type: 'system', content: '{"event":"channel_poke"}', attachments: [] } as unknown as MessageWithUser;
beforeEach(() => useChatStore.setState({ messages: new Map(), detachedChannels: new Map(), realtimeMessageEvents: [] }));
describe('passive channel poke history', () => {
  it('stores and deduplicates without scheduling message notifications', () => {
    useChatStore.getState().addRealtimeMessage('chat', message);
    useChatStore.getState().addRealtimeMessage('chat', message);
    expect(useChatStore.getState().messages.get('chat')).toHaveLength(1);
    expect(useChatStore.getState().realtimeMessageEvents).toEqual([]);
  });
  it('preserves a detached history window without alerting', () => {
    useChatStore.setState({ detachedChannels: new Map([['chat', []]]) });
    useChatStore.getState().addRealtimeMessage('chat', message);
    expect(useChatStore.getState().detachedChannels.get('chat')).toHaveLength(1);
    expect(useChatStore.getState().messages.has('chat')).toBe(false);
    expect(useChatStore.getState().realtimeMessageEvents).toEqual([]);
  });
});
