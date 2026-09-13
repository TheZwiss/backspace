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

import { stopScreenShare, handleScreenShareUnpublished, republishScreenShare } from './screenShare';
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

describe('an explicit stop clears both publications and broadcasts once', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceStore.setState({ isScreenSharing: true, hwOverdrive: false });
  });

  it('unpublishes the audio track even when the video track throws', async () => {
    const videoPub = { track: { kind: 'video' } };
    const audioPub = { track: { kind: 'audio' } };
    const unpublishTrack = vi.fn(async (track: { kind: string }) => {
      if (track.kind === 'video') throw new Error('gone');
    });
    const room = {
      localParticipant: {
        getTrackPublication: vi.fn((source: string) =>
          source === 'screen_share' ? videoPub : audioPub),
        unpublishTrack,
      },
    } as never;

    await stopScreenShare(room);

    // The loop used to sit in one try: a throw on the video publication left the
    // screen-share audio published with no control left that could stop it.
    expect(unpublishTrack).toHaveBeenCalledTimes(2);
    expect(unpublishTrack.mock.calls[1]![0]).toBe(audioPub.track);
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
  });

  it('broadcasts once even though the unpublish reaches the OS-stop handler', async () => {
    const room = {
      localParticipant: {
        getTrackPublication: vi.fn((source: string) =>
          source === 'screen_share' ? { track: { kind: 'video' } } : undefined),
        // livekit-client emits LocalTrackUnpublished synchronously inside
        // unpublishTrack, and useLiveKit routes that to this handler.
        unpublishTrack: vi.fn(async () => { handleScreenShareUnpublished(); }),
      },
    } as never;

    await stopScreenShare(room);

    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(broadcastVoiceStatus).toHaveBeenCalledTimes(1);
  });
});

describe('a republish that fails to land tells the room the share is gone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceStore.setState({ isScreenSharing: true, hwOverdrive: false });
    // jsdom has no MediaStream; republishScreenShare builds one from the live tracks.
    (globalThis as { MediaStream?: unknown }).MediaStream = class {
      tracks: { kind: string; readyState: string; stop: () => void }[];
      constructor(tracks: { kind: string; readyState: string; stop: () => void }[]) { this.tracks = tracks; }
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
      getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    };
  });

  it('broadcasts when the fresh publish throws', async () => {
    const mediaStreamTrack = { kind: 'video', readyState: 'live', contentHint: '', stop: vi.fn() };
    const videoPub = { track: { mediaStreamTrack } };
    const room = {
      localParticipant: {
        getTrackPublication: vi.fn((source: string) =>
          source === 'screen_share' ? videoPub : undefined),
        unpublishTrack: vi.fn(async () => {}),
        publishTrack: vi.fn(async () => { throw new Error('negotiation failed'); }),
      },
    } as never;

    await republishScreenShare(room);

    // The swap suppresses the unpublish handler and a publish that never landed
    // emits no rollback event, so this is the only thing that can carry the stop
    // to the channel lists and join sheets outside the LiveKit room.
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(broadcastVoiceStatus).toHaveBeenCalledTimes(1);
  });
});
