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
  stopScreenShare: vi.fn(async () => {}),
  applyOverdrive: vi.fn(async () => true),
}));

import { handleScreenShareAction, handleScreenShareActionForWindow } from './voiceActions';
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
    useScreenShareSetupStore.setState({ isOpen: false, targetDocument: null });
  });

  it('opens the setup screen instead of capturing when idle', async () => {
    await handleScreenShareAction();
    expect(useScreenShareSetupStore.getState().isOpen).toBe(true);
    expect(stopScreenShare).not.toHaveBeenCalled();
    expect(broadcastVoiceStatus).not.toHaveBeenCalled();
  });

  it('opens the setup in the detached window and resets the target on close', async () => {
    const childDocument = document.implementation.createHTMLDocument('call');
    await handleScreenShareActionForWindow(childDocument);
    expect(useScreenShareSetupStore.getState().targetDocument).toBe(childDocument);
    useScreenShareSetupStore.getState().close();
    expect(useScreenShareSetupStore.getState().targetDocument).toBeNull();
    await handleScreenShareAction();
    expect(useScreenShareSetupStore.getState().targetDocument).toBeNull();
  });

  it('delegates the stop when live, leaving the broadcast to stopScreenShare', async () => {
    useVoiceStore.setState({ isScreenSharing: true });
    await handleScreenShareAction();
    expect(stopScreenShare).toHaveBeenCalledWith(room);
    expect(useScreenShareSetupStore.getState().isOpen).toBe(false);
    // stopScreenShare owns the voice_status broadcast so that every stop path
    // gets it, not just this one; see screenShare.stopPaths.test.ts.
    expect(broadcastVoiceStatus).not.toHaveBeenCalled();
  });

  it('does nothing without a room', async () => {
    vi.mocked(getActiveRoom).mockReturnValue(null);
    await handleScreenShareAction();
    expect(useScreenShareSetupStore.getState().isOpen).toBe(false);
    expect(stopScreenShare).not.toHaveBeenCalled();
  });
});
