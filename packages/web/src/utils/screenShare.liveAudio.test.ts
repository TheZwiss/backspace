import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import {
  publishScreenShare,
  stopScreenShare,
  handleScreenShareUnpublished,
  syncScreenShareAudio,
  canAddScreenShareAudioLater,
} from './screenShare';

/**
 * The System Audio toggle while a share is live (#301). The toggle used to be
 * read only when the capture was taken, so turning it off kept sending audio
 * and turning it on never started it. These pin what each state of the live
 * share does with a toggle change.
 */

vi.mock('./hwOverdrive', () => ({ activate: vi.fn(), deactivate: vi.fn() }));
vi.mock('./voice', () => ({ broadcastVoiceStatus: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('./livekitInternals', () => ({ getPublisherPC: vi.fn(() => null), getMediaStreamTrack: vi.fn(() => null) }));
vi.mock('./streamHostLimits', () => ({
  getStreamHostLimits: () => ({
    minBitrateKbps: 500,
    maxBitrateKbps: 20_000,
    allowCustomBitrate: true,
    bitrateMatrixOverrides: null,
    allowedResolutions: [540, 720, 1080, 1440, 2160, 'native'],
    allowedFramerates: [30, 45, 60, 75, 90, 120],
  }),
}));

type FakeTrack = {
  id: string;
  kind: 'video' | 'audio';
  readyState: 'live' | 'ended';
  contentHint: string;
  stop: ReturnType<typeof vi.fn>;
  applyConstraints: ReturnType<typeof vi.fn>;
  getSettings: () => MediaTrackSettings;
};

function makeTrack(kind: FakeTrack['kind'], id = `${kind}-1`): FakeTrack {
  const track: FakeTrack = {
    id,
    kind,
    readyState: 'live',
    contentHint: '',
    stop: vi.fn(() => { track.readyState = 'ended'; }),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    getSettings: () => ({}),
  };
  return track;
}

function makeStream(video: FakeTrack, audio?: FakeTrack): MediaStream {
  const tracks = [video, ...(audio ? [audio] : [])];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => [video],
    getAudioTracks: () => (audio ? [audio] : []),
  } as unknown as MediaStream;
}

/**
 * A local participant that keeps its publications like livekit-client does:
 * publishTrack adds one per source, unpublishTrack removes it.
 */
function fakeRoom() {
  const pubs = new Map<string, { source: string; track: { mediaStreamTrack: FakeTrack } }>();
  const localParticipant = {
    publishTrack: vi.fn(async (mst: FakeTrack, opts: { source: string }) => {
      const pub = { source: opts.source, track: { mediaStreamTrack: mst } };
      pubs.set(opts.source, pub);
      return pub;
    }),
    unpublishTrack: vi.fn(async (track: { mediaStreamTrack: FakeTrack }, stop?: boolean) => {
      for (const [source, pub] of pubs) {
        if (pub.track === track) pubs.delete(source);
      }
      if (stop !== false) track.mediaStreamTrack.stop();
    }),
    getTrackPublication: vi.fn((source: string) => pubs.get(source)),
    getTrackPublications: vi.fn(() => [...pubs.values()]),
  };
  return { room: { localParticipant } as never, localParticipant, pubs };
}

function setShareAudio(shareAudio: boolean): void {
  useVoiceStore.getState().setScreenShareConfig({ shareAudio });
}

const getDisplayMedia = vi.fn();

function installElectron(api: Partial<BackspaceElectronAPI> | null): void {
  if (api) (window as { backspace?: unknown }).backspace = api;
  else delete (window as { backspace?: unknown }).backspace;
}

beforeEach(() => {
  vi.clearAllMocks();
  installElectron(null);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
  useVoiceStore.setState({
    ...useVoiceStore.getInitialState(),
    screenShareConfig: { height: 1080, fps: 60, mode: 'gaming', customBitrateKbps: null, shareAudio: true, codec: 'vp9' },
  });
  useUIStore.setState({ toasts: [] });
});

afterEach(() => {
  installElectron(null);
});

describe('starting a share honours the toggle as it stands at Start', () => {
  it('does not publish captured audio when the toggle was turned off after picking', async () => {
    const { room, localParticipant } = fakeRoom();
    const audio = makeTrack('audio');
    setShareAudio(false);

    await publishScreenShare(room, makeStream(makeTrack('video'), audio));

    expect(localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(localParticipant.publishTrack.mock.calls[0]![1]).toMatchObject({ source: Track.Source.ScreenShare });
    // Held, not stopped: turning the toggle back on can publish it again.
    expect(audio.stop).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().screenShareAudio).toBe('held');
  });

  it('reports the audio as published when it went out with the video', async () => {
    const { room } = fakeRoom();
    await publishScreenShare(room, makeStream(makeTrack('video'), makeTrack('audio')));
    expect(useVoiceStore.getState().screenShareAudio).toBe('published');
  });
});

describe('turning System Audio off mid-stream', () => {
  it('withdraws the audio publication and keeps the capture for later', async () => {
    const { room, localParticipant, pubs } = fakeRoom();
    const audio = makeTrack('audio');
    await publishScreenShare(room, makeStream(makeTrack('video'), audio));

    setShareAudio(false);
    await syncScreenShareAudio(room);

    expect(pubs.has(Track.Source.ScreenShareAudio)).toBe(false);
    expect(localParticipant.unpublishTrack).toHaveBeenCalledWith(expect.objectContaining({ mediaStreamTrack: audio }), false);
    expect(audio.stop).not.toHaveBeenCalled();
    // The video keeps running: no restart for an audio change.
    expect(pubs.has(Track.Source.ScreenShare)).toBe(true);
    expect(useVoiceStore.getState().screenShareAudio).toBe('held');
  });

  it('publishes the same capture again when turned back on', async () => {
    const { room, localParticipant, pubs } = fakeRoom();
    const audio = makeTrack('audio');
    await publishScreenShare(room, makeStream(makeTrack('video'), audio));
    setShareAudio(false);
    await syncScreenShareAudio(room);

    setShareAudio(true);
    await syncScreenShareAudio(room);

    expect(pubs.get(Track.Source.ScreenShareAudio)?.track.mediaStreamTrack).toBe(audio);
    expect(localParticipant.publishTrack).toHaveBeenLastCalledWith(
      audio,
      expect.objectContaining({ source: Track.Source.ScreenShareAudio, forceStereo: true }),
    );
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().screenShareAudio).toBe('published');
  });
});

describe('turning System Audio on for a share that started without it', () => {
  it('captures loopback audio for the same source on the desktop app and publishes it', async () => {
    const preselectScreenSource = vi.fn().mockResolvedValue(undefined);
    installElectron({ preselectScreenSource } as Partial<BackspaceElectronAPI>);
    const { room, pubs } = fakeRoom();
    setShareAudio(false);
    await publishScreenShare(room, makeStream(makeTrack('video')), { sourceId: 'screen:0:0' });
    expect(useVoiceStore.getState().screenShareAudio).toBe('acquirable');

    const extraVideo = makeTrack('video', 'video-2');
    const loopback = makeTrack('audio', 'audio-2');
    getDisplayMedia.mockResolvedValue(makeStream(extraVideo, loopback));
    setShareAudio(true);
    await syncScreenShareAudio(room);

    expect(preselectScreenSource).toHaveBeenCalledWith('screen:0:0', true);
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({ restrictOwnAudio: true, channelCount: 2 }),
    }));
    // The second capture exists only for its audio.
    expect(extraVideo.stop).toHaveBeenCalled();
    expect(pubs.get(Track.Source.ScreenShareAudio)?.track.mediaStreamTrack).toBe(loopback);
    expect(useVoiceStore.getState().screenShareAudio).toBe('published');
  });

  it('turns the toggle back off and says so when the capture fails', async () => {
    installElectron({ preselectScreenSource: vi.fn().mockResolvedValue(undefined) } as Partial<BackspaceElectronAPI>);
    const { room, pubs } = fakeRoom();
    setShareAudio(false);
    await publishScreenShare(room, makeStream(makeTrack('video')), { sourceId: 'screen:0:0' });

    getDisplayMedia.mockRejectedValue(new DOMException('loopback unsupported', 'NotReadableError'));
    setShareAudio(true);
    await syncScreenShareAudio(room);

    expect(pubs.has(Track.Source.ScreenShareAudio)).toBe(false);
    expect(useVoiceStore.getState().screenShareConfig.shareAudio).toBe(false);
    expect(useVoiceStore.getState().screenShareAudio).toBe('acquirable');
    expect(useUIStore.getState().toasts.map((t) => t.message)).toContain('Could not add system audio to the stream.');
  });

  it('does not prompt again in a browser, where audio is granted only with the capture', async () => {
    const { room, localParticipant } = fakeRoom();
    setShareAudio(false);
    await publishScreenShare(room, makeStream(makeTrack('video')), { sourceId: null });
    expect(useVoiceStore.getState().screenShareAudio).toBe('unavailable');

    setShareAudio(true);
    await syncScreenShareAudio(room);

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().screenShareAudio).toBe('unavailable');
  });

  it('holds a capture that arrives after the toggle was turned off again', async () => {
    installElectron({ preselectScreenSource: vi.fn().mockResolvedValue(undefined) } as Partial<BackspaceElectronAPI>);
    const { room, pubs } = fakeRoom();
    setShareAudio(false);
    await publishScreenShare(room, makeStream(makeTrack('video')), { sourceId: 'screen:0:0' });

    const loopback = makeTrack('audio', 'audio-2');
    getDisplayMedia.mockImplementation(async () => {
      setShareAudio(false);
      return makeStream(makeTrack('video', 'video-2'), loopback);
    });
    setShareAudio(true);
    await syncScreenShareAudio(room);

    expect(pubs.has(Track.Source.ScreenShareAudio)).toBe(false);
    expect(loopback.stop).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().screenShareAudio).toBe('held');
  });
});

describe('a withdrawn capture ends with the share', () => {
  it('is stopped by an explicit stop', async () => {
    const { room } = fakeRoom();
    const audio = makeTrack('audio');
    setShareAudio(false);
    await publishScreenShare(room, makeStream(makeTrack('video'), audio));

    await stopScreenShare(room);

    expect(audio.stop).toHaveBeenCalled();
    expect(useVoiceStore.getState().screenShareAudio).toBeNull();
  });

  it('is stopped when the OS stop bar ends the share', async () => {
    const { room } = fakeRoom();
    const audio = makeTrack('audio');
    setShareAudio(false);
    await publishScreenShare(room, makeStream(makeTrack('video'), audio));

    handleScreenShareUnpublished();

    expect(audio.stop).toHaveBeenCalled();
    expect(useVoiceStore.getState().screenShareAudio).toBeNull();
  });
});

describe('canAddScreenShareAudioLater (the setup screen asks it before Start)', () => {
  it('is true for a source the desktop app listed and can preselect', () => {
    installElectron({ preselectScreenSource: vi.fn() } as Partial<BackspaceElectronAPI>);
    expect(canAddScreenShareAudioLater('window:42:0')).toBe(true);
  });

  it('is false without a listed source (portal or prompted capture)', () => {
    installElectron({ preselectScreenSource: vi.fn() } as Partial<BackspaceElectronAPI>);
    expect(canAddScreenShareAudioLater(null)).toBe(false);
  });

  it('is false on a desktop build too old to preselect', () => {
    installElectron({} as Partial<BackspaceElectronAPI>);
    expect(canAddScreenShareAudioLater('screen:0:0')).toBe(false);
  });

  it('is false in a browser', () => {
    expect(canAddScreenShareAudioLater('screen:0:0')).toBe(false);
  });
});
