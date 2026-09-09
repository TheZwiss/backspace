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
const room = { localParticipant: {} };
vi.mock('../hooks/useLiveKit', () => ({
  getActiveRoom: vi.fn(() => room),
}));
vi.mock('./voice', () => ({
  broadcastVoiceStatus: vi.fn(),
  broadcastDeafenViaLiveKit: vi.fn(),
}));
vi.mock('./screenShare', () => ({
  CAMERA_PRESET: { resolution: { width: 1280, height: 720 }, encoding: { maxBitrate: 1, maxFramerate: 30 }, codec: 'h264' },
  stopScreenShare: vi.fn(async () => {}),
}));

import { handleScreenShareAction } from './voiceActions';
import { stopScreenShare } from './screenShare';
import { broadcastVoiceStatus } from './voice';
import { getActiveRoom } from '../hooks/useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { useScreenShareSetupStore } from '../stores/screenShareSetupStore';

describe('handleScreenShareAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveRoom).mockReturnValue(room as never);
    useVoiceStore.setState({ isScreenSharing: false });
    useScreenShareSetupStore.setState({ isOpen: false });
  });

  it('opens the setup screen instead of capturing when idle', async () => {
    await handleScreenShareAction();
    expect(useScreenShareSetupStore.getState().isOpen).toBe(true);
    expect(stopScreenShare).not.toHaveBeenCalled();
    expect(broadcastVoiceStatus).not.toHaveBeenCalled();
  });

  it('stops the share and broadcasts when live', async () => {
    useVoiceStore.setState({ isScreenSharing: true });
    await handleScreenShareAction();
    expect(stopScreenShare).toHaveBeenCalledWith(room);
    expect(broadcastVoiceStatus).toHaveBeenCalled();
    expect(useScreenShareSetupStore.getState().isOpen).toBe(false);
  });

  it('does nothing without a room', async () => {
    vi.mocked(getActiveRoom).mockReturnValue(null);
    await handleScreenShareAction();
    expect(useScreenShareSetupStore.getState().isOpen).toBe(false);
    expect(stopScreenShare).not.toHaveBeenCalled();
  });
});
