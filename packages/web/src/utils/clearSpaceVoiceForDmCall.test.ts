import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub heavy / side-effectful imports pulled in transitively by utils/voice.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));
vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
}));
vi.mock('../stores/instanceStore', async () => {
  const { create } = await import('zustand');
  const store = create<{ instances: unknown[] }>()(() => ({ instances: [] }));
  return { useInstanceStore: store };
});

import { clearSpaceVoiceForDmCall } from './voice';
import { wsSend } from '../hooks/useWebSocket';
import { useSpaceStore } from '../stores/spaceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';

describe('clearSpaceVoiceForDmCall', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 'me' } as never });
    useVoiceStore.setState({
      currentVoiceChannelId: null,
      activeDmCall: null,
      voiceUsers: new Map(),
    });
  });

  it('clears currentVoiceChannelId and removes self from the space channel', () => {
    useVoiceStore.setState({
      currentVoiceChannelId: 'space-1',
      voiceUsers: new Map([['space-1', ['me', 'other']]]),
    });

    clearSpaceVoiceForDmCall();

    const s = useVoiceStore.getState();
    expect(s.currentVoiceChannelId).toBeNull();
    expect(s.voiceUsers.get('space-1')).toEqual(['other']);
  });

  it('preserves activeDmCall (the caller/acceptor just set it)', () => {
    useVoiceStore.setState({
      currentVoiceChannelId: 'space-1',
      activeDmCall: { dmChannelId: 'dm-9', federatedCallId: null, callOrigin: null, livekit: null },
      voiceUsers: new Map([['space-1', ['me']]]),
    });

    clearSpaceVoiceForDmCall();

    const s = useVoiceStore.getState();
    expect(s.currentVoiceChannelId).toBeNull();
    expect(s.activeDmCall).toEqual({ dmChannelId: 'dm-9', federatedCallId: null, callOrigin: null, livekit: null });
  });

  it('is a no-op when not in a space voice channel', () => {
    useVoiceStore.setState({ currentVoiceChannelId: null, activeDmCall: { dmChannelId: 'dm-1', federatedCallId: null, callOrigin: null, livekit: null } });

    clearSpaceVoiceForDmCall();

    expect(useVoiceStore.getState().activeDmCall).toEqual({ dmChannelId: 'dm-1', federatedCallId: null, callOrigin: null, livekit: null });
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
  });

  it('tells the channel\'s instance the user left when the call goes through another one', () => {
    vi.mocked(wsSend).mockClear();
    useSpaceStore.setState({ channelOriginMap: new Map([['space-1', 'https://orbit.example']]) });
    useVoiceStore.setState({
      currentVoiceChannelId: 'space-1',
      activeDmCall: { dmChannelId: 'dm-9', federatedCallId: null, callOrigin: null, livekit: null },
      voiceUsers: new Map([['space-1', ['me']]]),
    });

    clearSpaceVoiceForDmCall();

    expect(wsSend).toHaveBeenCalledWith({ type: 'voice_leave' }, 'https://orbit.example');
  });

  it('leaves the channel to its instance when the call goes through the same one', () => {
    vi.mocked(wsSend).mockClear();
    useSpaceStore.setState({ channelOriginMap: new Map([['space-1', 'https://orbit.example'], ['dm-9', 'https://orbit.example']]) });
    useVoiceStore.setState({
      currentVoiceChannelId: 'space-1',
      activeDmCall: { dmChannelId: 'dm-9', federatedCallId: null, callOrigin: null, livekit: null },
      voiceUsers: new Map([['space-1', ['me']]]),
    });

    clearSpaceVoiceForDmCall();

    expect(wsSend).not.toHaveBeenCalled();
  });
});
