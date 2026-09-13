import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPresets, BackupCodecPolicy, Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import i18n from '../i18n';
import {
  buildScreenShareOptions,
  getPublishedScreenShareCodec,
  publishScreenShare,
  stageScreenCapture,
  stopScreenShare,
} from './screenShare';

const sdp = vi.hoisted(() => ({ activate: vi.fn(), deactivate: vi.fn() }));
const internals = vi.hoisted(() => ({ getPublisherPC: vi.fn(), getMediaStreamTrack: vi.fn() }));
vi.mock('./hwOverdrive', () => sdp);
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ setInputVolume: vi.fn() }) },
}));
vi.mock('../stores/settingsStore', () => ({
  getStreamingLimits: () => ({
    minBitrateKbps: 500,
    maxBitrateKbps: 20_000,
    allowCustomBitrate: true,
    bitrateMatrixOverrides: null,
  }),
}));
vi.mock('./livekitInternals', () => internals);

type FakeTrack = {
  kind: 'video' | 'audio';
  readyState: 'live';
  contentHint: string;
  stop: ReturnType<typeof vi.fn>;
};

function makeTrack(kind: FakeTrack['kind']): FakeTrack {
  return { kind, readyState: 'live', contentHint: '', stop: vi.fn() };
}

function makeVideoTrack(id = 'screen-video') {
  return {
    ...makeTrack('video'),
    id,
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn(() => ({ width: 2560, height: 1440 })),
  };
}

function makeStream(video = makeTrack('video'), audio?: FakeTrack) {
  const tracks = [video, ...(audio ? [audio] : [])];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => [video],
    getAudioTracks: () => audio ? [audio] : [],
  } as unknown as MediaStream;
}

function fakeRoom() {
  return {
    localParticipant: {
      publishTrack: vi.fn().mockResolvedValue({}),
      unpublishTrack: vi.fn().mockResolvedValue(undefined),
      getTrackPublication: vi.fn(),
      getTrackPublications: vi.fn(() => []),
    },
  } as any;
}

function attachPublishedSender(
  room: ReturnType<typeof fakeRoom>,
  video: ReturnType<typeof makeVideoTrack>,
  reports: Array<[string, Record<string, unknown>]>,
) {
  const publicationTrack = { mediaStreamTrack: video };
  const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
  room.localParticipant.getTrackPublications.mockReturnValue([publication]);
  const sender = {
    track: { id: video.id },
    getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
    setParameters: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue(new Map(reports)),
  };
  internals.getPublisherPC.mockReturnValue({ getSenders: vi.fn(() => [sender]) });
  internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);
  return sender;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  internals.getPublisherPC.mockReturnValue(null);
  internals.getMediaStreamTrack.mockReturnValue(null);
  localStorage.clear();
  useVoiceStore.setState({
    ...useVoiceStore.getInitialState(),
    screenShareConfig: {
      height: 1440,
      fps: 60,
      mode: 'gaming',
      customBitrateKbps: 18_000,
      shareAudio: true,
      codec: 'vp9',
    },
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('screen-share media options', () => {
  it('publishes VP9 directly without enabling the H.264 SDP hook', async () => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    attachPublishedSender(room, video, [
      ['codec-vp9', { id: 'codec-vp9', type: 'codec', mimeType: 'video/VP9' }],
      ['outbound-vp9', {
        id: 'outbound-vp9', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesSent: 100,
      }],
    ]);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);

    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: Track.Source.ScreenShare, videoCodec: 'vp9' }),
    );
    expect(getPublishedScreenShareCodec()).toBe('vp9');
    expect(sdp.activate).not.toHaveBeenCalled();
    expect(sdp.deactivate).not.toHaveBeenCalled();
  });

  it('uses the persisted codec on the first publication and keeps it after stop', async () => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['outbound-h264', {
        id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 100, encoderImplementation: 'VideoToolbox',
      }],
    ]);
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ videoCodec: 'h264' }),
    );
    expect(getPublishedScreenShareCodec()).toBe('h264');
    expect(sdp.activate).toHaveBeenCalledOnce();
    expect(sdp.deactivate).toHaveBeenCalledOnce();

    await stopScreenShare(room);
    expect(getPublishedScreenShareCodec()).toBeNull();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('h264');
  });

  it('requests unprocessed stereo capture and publishes stereo music audio', async () => {
    const video = makeTrack('video');
    const audio = makeTrack('audio');
    const stream = makeStream(video, audio);
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });

    await stageScreenCapture();
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
      }),
    }));

    const room = fakeRoom();
    await publishScreenShare(room, stream);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      audio,
      expect.objectContaining({
        source: Track.Source.ScreenShareAudio,
        audioPreset: AudioPresets.musicHighQualityStereo,
        dtx: false,
        red: false,
        forceStereo: true,
      }),
    );
  });

  it('keeps the measured Gaming/Text adaptation and dynacast-managed VP8 backup without the ignored minBitrate member', () => {
    const base = useVoiceStore.getState().screenShareConfig;
    const gaming = buildScreenShareOptions({ ...base, mode: 'gaming' });
    const text = buildScreenShareOptions({ ...base, mode: 'text' });

    expect(gaming.contentHint).toBe('motion');
    expect(gaming.overdrive.degradationPreference).toBe('balanced');
    expect(text.contentHint).toBe('detail');
    expect(text.overdrive.degradationPreference).toBe('maintain-resolution');
    expect(gaming.publish.backupCodecPolicy).toBe(BackupCodecPolicy.SIMULCAST);
    expect(gaming.overdrive).not.toHaveProperty('minBitrate');
  });

  it('retries until the screen-share sender is ready and reasserts the ceiling at five seconds', async () => {
    const video = makeVideoTrack();
    const publicationTrack = { mediaStreamTrack: video };
    const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
    const room = fakeRoom();
    room.localParticipant.getTrackPublications.mockReturnValue([publication]);

    const sender = {
      track: { id: video.id },
      getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
    const peerConnection = { getSenders: vi.fn((): typeof sender[] => []) };
    internals.getPublisherPC.mockReturnValue(peerConnection);
    internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.setParameters).not.toHaveBeenCalled();

    peerConnection.getSenders.mockReturnValue([sender]);
    await vi.advanceTimersByTimeAsync(250);
    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(video.applyConstraints).toHaveBeenCalledOnce();
    expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 18_000_000, maxFramerate: 60 })],
      degradationPreference: 'balanced',
    }));

    await vi.advanceTimersByTimeAsync(4750);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    expect(video.applyConstraints).toHaveBeenCalledOnce();
  });

  it('retries an empty placeholder encoding and continues when capture constraints fail', async () => {
    const video = makeVideoTrack();
    video.applyConstraints.mockRejectedValue(new DOMException('unsupported', 'OverconstrainedError'));
    const publicationTrack = { mediaStreamTrack: video };
    const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
    const room = fakeRoom();
    room.localParticipant.getTrackPublications.mockReturnValue([publication]);
    let encodings: RTCRtpEncodingParameters[] = [{}];
    const sender = {
      track: { id: video.id },
      getParameters: vi.fn(() => ({ encodings })),
      setParameters: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue(new Map()),
    };
    internals.getPublisherPC.mockReturnValue({ getSenders: vi.fn(() => [sender]) });
    internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.setParameters).not.toHaveBeenCalled();

    encodings = [{ active: true }];
    await vi.advanceTimersByTimeAsync(250);
    expect(sender.setParameters).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4750);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    expect(video.applyConstraints).toHaveBeenCalledOnce();
  });

  it('retries negotiated-codec inspection until the sender appears', async () => {
    const video = makeVideoTrack();
    const publicationTrack = { mediaStreamTrack: video };
    const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
    const room = fakeRoom();
    room.localParticipant.getTrackPublications.mockReturnValue([publication]);
    const sender = {
      track: { id: video.id },
      getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
      setParameters: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue(new Map([
        ['codec-vp9', { id: 'codec-vp9', type: 'codec', mimeType: 'video/VP9' }],
        ['outbound-vp9', {
          id: 'outbound-vp9', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesSent: 100,
        }],
      ])),
    };
    const peerConnection = { getSenders: vi.fn((): typeof sender[] => []) };
    internals.getPublisherPC.mockReturnValue(peerConnection);
    internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(getPublishedScreenShareCodec()).toBeNull();

    peerConnection.getSenders.mockReturnValue([sender]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getPublishedScreenShareCodec()).toBe('vp9');
  });

  it('warns with localized copy when H264 falls back to OpenH264 software encoding', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    const video = makeVideoTrack();
    const room = fakeRoom();
    attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['codec-vp8', { id: 'codec-vp8', type: 'codec', mimeType: 'video/VP8' }],
      ['outbound-h264', {
        id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 100, encoderImplementation: 'OpenH264',
      }],
      ['outbound-vp8', {
        id: 'outbound-vp8', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp8',
        bytesSent: 0, encoderImplementation: 'libvpx',
      }],
    ]);
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);

    expect(getPublishedScreenShareCodec()).toBe('h264');
    expect(addToast).toHaveBeenCalledWith(
      i18n.t('voice:streamSettings.softwareH264Fallback'),
      'warning',
      8000,
    );
  });

  it('migrates older saved settings to VP9 once and persists subsequent choices', async () => {
    localStorage.setItem('backspace-voice-settings', JSON.stringify({
      version: 13,
      state: {
        screenShareConfig: {
          height: 1080,
          fps: 30,
          mode: 'text',
          customBitrateKbps: null,
          shareAudio: false,
        },
      },
    }));

    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('vp9');

    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
  });
});
