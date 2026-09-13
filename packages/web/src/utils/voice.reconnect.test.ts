import { beforeEach, describe, expect, it, vi } from 'vitest';

const wsSend = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useWebSocket', () => ({ wsSend }));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

import { useVoiceStore } from '../stores/voiceStore';
import { broadcastVoiceStatus } from './voice';

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
