import { beforeEach, describe, expect, it, vi } from 'vitest';

const wsSend = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useWebSocket', () => ({ wsSend }));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: () => ({
      clearInputDenial: vi.fn(),
      resumeContext: vi.fn().mockResolvedValue(undefined),
      setInputDevice: vi.fn().mockResolvedValue(null),
    }),
  },
}));

import { useVoiceStore } from '../stores/voiceStore';
import { broadcastVoiceStatus, joinVoiceChannel } from './voice';

describe('voice status resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceStore.setState({
      ...useVoiceStore.getInitialState(),
      currentVoiceChannelId: null,
      activeDmCall: { dmChannelId: 'dm-reconnect' },
      callOrigin: 'https://calls.example',
      isMuted: true,
      isDeafened: false,
      isCameraOn: true,
      isScreenSharing: false,
    });
  });

  it('sends voice_status for an active DM even though space channel state is null', () => {
    broadcastVoiceStatus();

    expect(wsSend).toHaveBeenCalledWith({
      type: 'voice_status',
      isMuted: true,
      isDeafened: false,
      isCameraOn: true,
      isScreenSharing: false,
    }, 'https://calls.example');
  });
});

describe('rejoining a dropped session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceStore.setState({
      ...useVoiceStore.getInitialState(),
      currentVoiceChannelId: 'channel-1',
      activeDmCall: null,
      callOrigin: null,
    });
  });

  it('reconnects when the retained channel is selected again after a drop', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ voiceConnectionStatus: 'disconnected' });

    joinVoiceChannel('channel-1', connectFn);

    expect(connectFn).toHaveBeenCalledWith('channel-1');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel-1');
  });

  it('stays a no-op while the session is still live', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ voiceConnectionStatus: 'connected' });

    joinVoiceChannel('channel-1', connectFn);

    expect(connectFn).not.toHaveBeenCalled();
  });

  it('stays a no-op while the session is still reconnecting on its own', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ voiceConnectionStatus: 'reconnecting' });

    joinVoiceChannel('channel-1', connectFn);

    expect(connectFn).not.toHaveBeenCalled();
  });
});
