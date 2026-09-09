import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the module graph screenShare.ts pulls in; only the broadcast matters here.
vi.mock('livekit-client', () => ({
  Room: class {},
  Track: { Source: { ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio', Camera: 'camera' } },
  BackupCodecPolicy: { SIMULCAST: 0 },
}));
vi.mock('./voice', () => ({ broadcastVoiceStatus: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../stores/instanceStore', async () => {
  const { create } = await import('zustand');
  return { useInstanceStore: create<{ instances: unknown[] }>()(() => ({ instances: [] })) };
});
vi.mock('./livekitInternals', () => ({ getPublisherPC: vi.fn(), getMediaStreamTrack: vi.fn() }));
vi.mock('./hwOverdrive', () => ({ activate: vi.fn(), deactivate: vi.fn() }));
vi.mock('../stores/screenShareSetupStore', () => ({ openScreenShareSetup: vi.fn() }));
vi.mock('../i18n', () => ({ default: { t: (k: string) => k } }));

import { stopScreenShare, handleScreenShareUnpublished } from './screenShare';
import { broadcastVoiceStatus } from './voice';
import { useVoiceStore } from '../stores/voiceStore';

/**
 * `voice_status` is what carries isScreenSharing to people who are not in the
 * LiveKit room (channel lists, join sheets). A stop that skips the broadcast
 * leaves a stale "sharing" indicator up for everyone browsing, so both stop
 * paths are pinned here: the explicit one and the OS/browser "Stop sharing" bar.
 */
function makeRoom(publications: Record<string, unknown> = {}) {
  return {
    localParticipant: {
      getTrackPublication: vi.fn((source: string) => publications[source]),
      unpublishTrack: vi.fn(async () => {}),
    },
  } as never;
}

describe('screen-share stop paths broadcast voice status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceStore.setState({ isScreenSharing: true, hwOverdrive: false });
  });

  it('stopScreenShare broadcasts and clears the sharing flag', async () => {
    await stopScreenShare(makeRoom());
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(broadcastVoiceStatus).toHaveBeenCalledTimes(1);
  });

  it('stopScreenShare still broadcasts when unpublishing throws', async () => {
    const room = {
      localParticipant: {
        getTrackPublication: vi.fn(() => ({ track: {} })),
        unpublishTrack: vi.fn(async () => { throw new Error('gone'); }),
      },
    } as never;
    await stopScreenShare(room);
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(broadcastVoiceStatus).toHaveBeenCalledTimes(1);
  });

  it('handleScreenShareUnpublished broadcasts for the OS-level stop bar', () => {
    handleScreenShareUnpublished();
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(broadcastVoiceStatus).toHaveBeenCalledTimes(1);
  });
});
