import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPresets, BackupCodecPolicy, ConnectionState, Track, type Room } from 'livekit-client';
import type { ParticipantInfo } from '../hooks/useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { useScreenShareSetupStore } from '../stores/screenShareSetupStore';
import { useUIStore } from '../stores/uiStore';
import i18n from '../i18n';
import {
  applyOverdrive,
  applyScreenCaptureConfig,
  buildScreenShareOptions,
  changeScreenShare,
  getPublishedScreenShareCodec,
  publishScreenShare,
  replaceScreenShare,
  stageScreenCapture,
  stopScreenShare,
} from './screenShare';

const sdp = vi.hoisted(() => ({ activate: vi.fn(), deactivate: vi.fn() }));
const internals = vi.hoisted(() => ({ getPublisherPC: vi.fn(), getMediaStreamTrack: vi.fn() }));
const nativeCapture = vi.hoisted(() => ({ canUse: vi.fn(), open: vi.fn() }));
const nativeControls = vi.hoisted(() => ({
  setResolution: vi.fn(() => false),
  setFrameRate: vi.fn(() => false),
  setBitrate: vi.fn(() => false),
  setCursorMode: vi.fn(() => false),
}));
const windowCropMocks = vi.hoisted(() => ({ canCrop: vi.fn(), open: vi.fn() }));
const systemAudio = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('./hwOverdrive', () => sdp);
vi.mock('./nativeScreenCapture', () => ({
  canUseNativeScreenCapture: nativeCapture.canUse,
  openNativeScreenCaptureTrack: nativeCapture.open,
  setNativeScreenCaptureResolution: nativeControls.setResolution,
  setNativeScreenCaptureFrameRate: nativeControls.setFrameRate,
  setNativeScreenCaptureBitrate: nativeControls.setBitrate,
  setNativeScreenCaptureCursorMode: nativeControls.setCursorMode,
}));
vi.mock('./windowCropCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./windowCropCapture')>();
  return {
    ...actual,
    canCropCaptureWindow: windowCropMocks.canCrop,
    openWindowCropTrack: windowCropMocks.open,
  };
});
vi.mock('./systemAudioSource', () => ({ acquireAppExcludedSystemAudio: systemAudio.acquire }));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ setInputVolume: vi.fn() }) },
}));
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
  const tracks: FakeTrack[] = [video, ...(audio ? [audio] : [])];
  return {
    addTrack: (track: FakeTrack) => { tracks.push(track); },
    removeTrack: (track: FakeTrack) => { const index = tracks.indexOf(track); if (index >= 0) tracks.splice(index, 1); },
    getTracks: () => [...tracks],
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
  } as unknown as MediaStream;
}

type FakeLocalParticipant = {
  publishTrack: ReturnType<typeof vi.fn>;
  unpublishTrack: ReturnType<typeof vi.fn>;
  publishData: ReturnType<typeof vi.fn>;
  getTrackPublication: ReturnType<typeof vi.fn>;
  getTrackPublications: ReturnType<typeof vi.fn>;
};

type FakeRoom = Room & { localParticipant: FakeLocalParticipant };

function fakeRoom(): FakeRoom {
  return {
    localParticipant: {
      publishTrack: vi.fn().mockResolvedValue({}),
      unpublishTrack: vi.fn().mockResolvedValue(undefined),
      publishData: vi.fn().mockResolvedValue(undefined),
      getTrackPublication: vi.fn(),
      getTrackPublications: vi.fn(() => []),
    },
  } as unknown as FakeRoom;
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
  nativeCapture.canUse.mockReturnValue(false);
  nativeCapture.open.mockReset();
  windowCropMocks.canCrop.mockReturnValue(false);
  windowCropMocks.open.mockReset();
  nativeControls.setResolution.mockReset().mockReturnValue(false);
  nativeControls.setFrameRate.mockReset().mockReturnValue(false);
  nativeControls.setBitrate.mockReset().mockReturnValue(false);
  nativeControls.setCursorMode.mockReset().mockReturnValue(false);
  systemAudio.acquire.mockResolvedValue(null);
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
  useScreenShareSetupStore.getState().close();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'backspace');
  vi.useRealTimers();
});

describe('screen-share media options', () => {
  it('applies quality changes to a native track without replacing it', async () => {
    const video = makeVideoTrack();
    nativeControls.setResolution.mockReturnValue(true);
    nativeControls.setFrameRate.mockReturnValue(true);
    nativeControls.setBitrate.mockReturnValue(true);
    nativeControls.setCursorMode.mockReturnValue(true);

    await applyScreenCaptureConfig(video as unknown as MediaStreamTrack, useVoiceStore.getState().screenShareConfig);

    expect(nativeControls.setResolution).toHaveBeenCalledWith(video, { width: 2560, height: 1440 });
    expect(nativeControls.setFrameRate).toHaveBeenCalledWith(video, 60);
    expect(nativeControls.setBitrate).toHaveBeenCalledWith(video, 18_000);
    expect(nativeControls.setCursorMode).toHaveBeenCalledWith(video, 'auto');
    expect(video.applyConstraints).not.toHaveBeenCalled();
  });

  it('uses native DXGI only for a selected screen and returns its track', async () => {
    const video = makeTrack('video');
    nativeCapture.canUse.mockReturnValue(true);
    nativeCapture.open.mockResolvedValue(video);
    useVoiceStore.setState({ screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, shareAudio: false } });
    Object.defineProperty(window, 'backspace', { configurable: true, value: { platform: 'win32' } });
    vi.stubGlobal('MediaStream', class {
      private readonly tracks: unknown[];
      constructor(tracks: unknown[] = []) { this.tracks = [...tracks]; }
      addTrack(track: unknown) { this.tracks.push(track); }
      removeTrack(track: unknown) { const index = this.tracks.indexOf(track); if (index >= 0) this.tracks.splice(index, 1); }
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'video'); }
      getAudioTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'audio'); }
    });
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });

    const stream = await stageScreenCapture('screen:display-1');

    expect(nativeCapture.open).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'screen:display-1',
      frameRate: 60,
      bitrateKbps: 18_000,
      cursorMode: 'auto',
    }));
    expect(stream.getVideoTracks()).toContain(video);
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('keeps Text mode on Chromium capture', async () => {
    nativeCapture.canUse.mockReturnValue(true);
    nativeCapture.open.mockResolvedValue(makeTrack('video'));
    useVoiceStore.setState({ screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, mode: 'text', shareAudio: false } });
    Object.defineProperty(window, 'backspace', { configurable: true, value: { platform: 'win32' } });
    vi.stubGlobal('MediaStream', class {
      private readonly tracks: unknown[];
      constructor(tracks: unknown[] = []) { this.tracks = [...tracks]; }
      addTrack(track: unknown) { this.tracks.push(track); }
      removeTrack(track: unknown) { const index = this.tracks.indexOf(track); if (index >= 0) this.tracks.splice(index, 1); }
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'video'); }
      getAudioTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'audio'); }
    });
    const chromium = makeStream(makeTrack('video'));
    const getDisplayMedia = vi.fn().mockResolvedValue(chromium);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });

    const result = await stageScreenCapture('screen:display-1');

    expect(result).toBe(chromium);
    expect(nativeCapture.open).not.toHaveBeenCalled();
    expect(getDisplayMedia).toHaveBeenCalledOnce();
  });

  it('honors an explicit hidden cursor in Text mode by using DXGI', async () => {
    nativeCapture.canUse.mockReturnValue(true);
    const nativeVideo = makeTrack('video');
    nativeCapture.open.mockResolvedValue(nativeVideo);
    useVoiceStore.setState({ screenShareConfig: {
      ...useVoiceStore.getState().screenShareConfig,
      mode: 'text', cursorMode: 'hide', shareAudio: false,
    } });
    Object.defineProperty(window, 'backspace', { configurable: true, value: { platform: 'win32' } });
    vi.stubGlobal('MediaStream', class {
      private readonly tracks: unknown[];
      constructor(tracks: unknown[] = []) { this.tracks = [...tracks]; }
      addTrack(track: unknown) { this.tracks.push(track); }
      removeTrack(track: unknown) { const index = this.tracks.indexOf(track); if (index >= 0) this.tracks.splice(index, 1); }
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'video'); }
      getAudioTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'audio'); }
    });
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });

    const stream = await stageScreenCapture('screen:display-1');

    expect(nativeCapture.open).toHaveBeenCalledWith(expect.objectContaining({ cursorMode: 'hide' }));
    expect(stream.getVideoTracks()).toContain(nativeVideo);
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('does not fall back to a cursor-bearing full-screen source for a game window', async () => {
    nativeCapture.canUse.mockReturnValue(true);
    nativeCapture.open.mockResolvedValue(null);
    windowCropMocks.canCrop.mockReturnValue(true);
    useVoiceStore.setState({
      screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, shareAudio: false },
    });
    Object.defineProperty(window, 'backspace', {
      configurable: true,
      value: {
        platform: 'win32',
        preselectScreenSource: vi.fn().mockResolvedValue(undefined),
        getWindowCaptureTarget: vi.fn().mockResolvedValue({
          screenSourceId: 'screen:1:0',
          monitor: { x: 0, y: 0, width: 1920, height: 1080 },
          crop: { x: 50, y: 50, width: 800, height: 600 },
          minimized: false,
          foreground: true,
          exclusive: false,
          isGame: true,
        }),
      },
    });
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });

    await expect(stageScreenCapture('window:42:0')).rejects.toThrow('cursor-free-window-capture-unavailable');
    expect(nativeCapture.open).toHaveBeenCalledOnce();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('keeps a native reopen callback available when a window starts in auto mode', async () => {
    nativeCapture.canUse.mockReturnValue(true);
    const cursorFreeTrack = makeTrack('video');
    nativeCapture.open.mockResolvedValue(cursorFreeTrack);
    windowCropMocks.canCrop.mockReturnValue(true);
    windowCropMocks.open.mockResolvedValue(makeTrack('video'));
    useVoiceStore.setState({ screenShareConfig: {
      ...useVoiceStore.getState().screenShareConfig,
      mode: 'text', cursorMode: 'auto', shareAudio: false,
    } });
    Object.defineProperty(window, 'backspace', {
      configurable: true,
      value: {
        platform: 'win32',
        preselectScreenSource: vi.fn().mockResolvedValue(undefined),
        getWindowCaptureTarget: vi.fn().mockResolvedValue({
          screenSourceId: 'screen:1:0',
          monitor: { x: 0, y: 0, width: 1920, height: 1080 },
          crop: { x: 50, y: 50, width: 800, height: 600 },
          minimized: false,
          foreground: true,
          exclusive: false,
          isGame: false,
        }),
      },
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockResolvedValue(makeStream(makeTrack('video'))) },
    });

    await stageScreenCapture('window:42:0');

    const options = windowCropMocks.open.mock.calls[0]?.[2] as {
      reopenDisplay?: (sourceId: string, mode: 'auto' | 'show' | 'hide') => Promise<MediaStreamTrack | null | undefined>;
    };
    expect(options.reopenDisplay).toEqual(expect.any(Function));
    await expect(options.reopenDisplay?.('screen:1:0', 'hide')).resolves.toBe(cursorFreeTrack);
    await expect(options.reopenDisplay?.('screen:1:0', 'show')).resolves.toBeUndefined();
    expect(nativeCapture.open).toHaveBeenCalledOnce();
  });

  it('falls back to Chromium when native DXGI does not produce a track', async () => {
    nativeCapture.canUse.mockReturnValue(true);
    nativeCapture.open.mockResolvedValue(null);
    const pickedAudio = makeTrack('audio');
    const ownFree = makeTrack('audio');
    systemAudio.acquire.mockResolvedValue(ownFree);
    const chromium = makeStream(makeTrack('video'), pickedAudio);
    const getDisplayMedia = vi.fn().mockResolvedValue(chromium);
    Object.defineProperty(window, 'backspace', { configurable: true, value: { platform: 'win32' } });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });

    const result = await stageScreenCapture('screen:display-1');

    expect(result).toBe(chromium);
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(result.getAudioTracks()).toEqual([ownFree]);
    expect(pickedAudio.stop).toHaveBeenCalledOnce();
    expect(ownFree.stop).not.toHaveBeenCalled();
  });

  it('keeps own-free system audio alive when native DXGI succeeds', async () => {
    const ownFree = makeTrack('audio');
    nativeCapture.canUse.mockReturnValue(true);
    nativeCapture.open.mockResolvedValue(makeTrack('video'));
    systemAudio.acquire.mockResolvedValue(ownFree);
    Object.defineProperty(window, 'backspace', { configurable: true, value: { platform: 'win32' } });
    vi.stubGlobal('MediaStream', class {
      private readonly tracks: unknown[];
      constructor(tracks: unknown[] = []) { this.tracks = [...tracks]; }
      addTrack(track: unknown) { this.tracks.push(track); }
      removeTrack(track: unknown) { const index = this.tracks.indexOf(track); if (index >= 0) this.tracks.splice(index, 1); }
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'video'); }
      getAudioTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'audio'); }
    });

    const stream = await stageScreenCapture('screen:display-1');

    expect(stream.getAudioTracks()).toEqual([ownFree]);
    expect(ownFree.stop).not.toHaveBeenCalled();
  });

  it('publishes DXGI video audio as the separate LiveKit screen-share audio source', async () => {
    const ownFree = makeTrack('audio');
    const nativeVideo = makeVideoTrack();
    nativeCapture.canUse.mockReturnValue(true);
    nativeCapture.open.mockResolvedValue(nativeVideo);
    systemAudio.acquire.mockResolvedValue(ownFree);
    Object.defineProperty(window, 'backspace', { configurable: true, value: { platform: 'win32' } });
    vi.stubGlobal('MediaStream', class {
      private readonly tracks: unknown[];
      constructor(tracks: unknown[] = []) { this.tracks = [...tracks]; }
      addTrack(track: unknown) { this.tracks.push(track); }
      removeTrack(track: unknown) { const index = this.tracks.indexOf(track); if (index >= 0) this.tracks.splice(index, 1); }
      getTracks() { return [...this.tracks]; }
      getVideoTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'video'); }
      getAudioTracks() { return this.tracks.filter((track) => (track as FakeTrack).kind === 'audio'); }
    });

    const stream = await stageScreenCapture('screen:display-1');
    const room = fakeRoom();
    await publishScreenShare(room, stream, { sourceId: 'screen:display-1', pickerMode: 'app' });

    expect(nativeCapture.open).toHaveBeenCalledOnce();
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      1,
      nativeVideo,
      expect.objectContaining({ source: Track.Source.ScreenShare }),
    );
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      2,
      ownFree,
      expect.objectContaining({ source: Track.Source.ScreenShareAudio, forceStereo: true }),
    );
    expect(useVoiceStore.getState().screenShareAudio).toBe('published');
    expect(ownFree.stop).not.toHaveBeenCalled();
  });

  it('opens replacement setup without stopping or unpublishing the live capture', async () => {
    const room = fakeRoom();
    room.state = ConnectionState.Connected;
    const video = makeVideoTrack('old-video');
    const publicationTrack = { mediaStreamTrack: video, replaceTrack: vi.fn() };
    const publication = { source: Track.Source.ScreenShare, videoTrack: publicationTrack, track: publicationTrack };
    room.localParticipant.getTrackPublication.mockReturnValue(publication);
    useVoiceStore.setState({ isScreenSharing: true });

    await changeScreenShare(room);

    expect(useScreenShareSetupStore.getState()).toMatchObject({ isOpen: true, mode: 'replace' });
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    expect(video.stop).not.toHaveBeenCalled();
  });

  it('keeps the old track and config live while replacement is pending, then commits in place', async () => {
    const room = fakeRoom();
    const oldVideo = makeVideoTrack('old-video');
    let finishReplacement!: () => void;
    const replaceTrack = vi.fn(() => new Promise<void>(resolve => { finishReplacement = resolve; }));
    const videoPublication = { mediaStreamTrack: oldVideo, replaceTrack };
    const publication = { source: Track.Source.ScreenShare, videoTrack: videoPublication, track: videoPublication };
    room.localParticipant.getTrackPublication.mockReturnValue(publication);
    const oldConfig = useVoiceStore.getState().screenShareConfig;
    useVoiceStore.setState({ isScreenSharing: true });
    const localParticipant: ParticipantInfo = {
      identity: 'local',
      userId: 'local',
      username: 'Local user',
      homeUserId: null,
      isMuted: false,
      isDeafened: false,
      isCameraOn: false,
      isScreenSharing: true,
      isLocal: true,
      audioTrack: null,
      videoTrack: null,
      screenTrack: oldVideo as unknown as MediaStreamTrack,
      screenAudioTrack: null,
      lkVideoTrack: null,
      lkScreenTrack: videoPublication as unknown as Track,
      cachedUser: null,
    };
    useVoiceStore.setState({ participants: [localParticipant] });
    const nextVideo = makeVideoTrack('next-video');
    const staged = makeStream(nextVideo);
    const nextConfig = { ...oldConfig, height: 720, fps: 45, mode: 'text' as const, shareAudio: false };

    const replacing = replaceScreenShare(room, staged, { config: nextConfig, sourceId: 'window:42:0', pickerMode: 'app' });
    await vi.waitFor(() => expect(replaceTrack).toHaveBeenCalledWith(nextVideo, { userProvidedTrack: true }));

    expect(oldVideo.readyState).toBe('live');
    expect(oldVideo.stop).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().screenShareConfig).toEqual(oldConfig);
    expect(useVoiceStore.getState().participants[0]?.screenTrack).toBe(oldVideo);
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();

    finishReplacement();
    await expect(replacing).resolves.toBe(true);

    expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(publication);
    expect(useVoiceStore.getState().screenShareConfig).toEqual(nextConfig);
    expect(useVoiceStore.getState().participants[0]?.screenTrack).toBe(nextVideo);
    expect(useVoiceStore.getState().participants[0]?.lkScreenTrack).toBe(videoPublication);
    expect(oldVideo.stop).toHaveBeenCalledOnce();
    expect(nextVideo.stop).not.toHaveBeenCalled();
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
  });

  it('keeps the old share and config when SDK replacement fails, and stops staged tracks', async () => {
    const room = fakeRoom();
    const oldVideo = makeVideoTrack('old-video');
    const videoPublication = {
      mediaStreamTrack: oldVideo,
      replaceTrack: vi.fn().mockRejectedValue(new Error('replace failed')),
    };
    const publication = { source: Track.Source.ScreenShare, videoTrack: videoPublication, track: videoPublication };
    room.localParticipant.getTrackPublication.mockReturnValue(publication);
    const oldConfig = useVoiceStore.getState().screenShareConfig;
    useVoiceStore.setState({ isScreenSharing: true });
    const nextVideo = makeVideoTrack('next-video');
    const stagedAudio = makeTrack('audio');
    const staged = makeStream(nextVideo, stagedAudio);
    const nextConfig = { ...oldConfig, height: 720, fps: 30, shareAudio: false };

    await expect(replaceScreenShare(room, staged, { config: nextConfig, sourceId: 'window:42:0', pickerMode: 'app' }))
      .resolves.toBe(false);

    expect(videoPublication.replaceTrack).toHaveBeenCalledOnce();
    expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(publication);
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    expect(useVoiceStore.getState().screenShareConfig).toEqual(oldConfig);
    expect(oldVideo.stop).not.toHaveBeenCalled();
    expect(nextVideo.stop).toHaveBeenCalledOnce();
    expect(stagedAudio.stop).toHaveBeenCalledOnce();
  });

  it('restores the previous SDK track when replaceTrack switches identity before rejecting', async () => {
    const room = fakeRoom();
    const oldVideo = makeVideoTrack('old-video');
    const nextVideo = makeVideoTrack('next-video');
    const videoPublicationTrack = {
      mediaStreamTrack: oldVideo,
      replaceTrack: vi.fn(async (next: typeof oldVideo) => {
        videoPublicationTrack.mediaStreamTrack = next;
        if (next === nextVideo) throw new Error('SDK rejected after changing sender track');
      }),
    };
    const publication = { source: Track.Source.ScreenShare, videoTrack: videoPublicationTrack, track: videoPublicationTrack };
    room.localParticipant.getTrackPublication.mockReturnValue(publication);
    const oldConfig = useVoiceStore.getState().screenShareConfig;
    useVoiceStore.setState({ isScreenSharing: true });

    await expect(replaceScreenShare(room, makeStream(nextVideo), {
      config: { ...oldConfig, height: 720 },
    })).resolves.toBe(false);

    expect(videoPublicationTrack.replaceTrack).toHaveBeenNthCalledWith(1, nextVideo, { userProvidedTrack: true });
    expect(videoPublicationTrack.replaceTrack).toHaveBeenNthCalledWith(2, oldVideo, { userProvidedTrack: true });
    expect(videoPublicationTrack.mediaStreamTrack).toBe(oldVideo);
    expect(useVoiceStore.getState().screenShareConfig).toEqual(oldConfig);
    expect(oldVideo.stop).not.toHaveBeenCalled();
    expect(nextVideo.stop).toHaveBeenCalledOnce();
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
  });

  it.each([false, true])('discards a stopped pending replacement even if sharing restarted: %s', async restarted => {
    const room = fakeRoom();
    const oldVideo = makeVideoTrack('old-video');
    const nextVideo = makeVideoTrack('next-video');
    let finishReplace!: () => void;
    const videoPublicationTrack = {
      mediaStreamTrack: oldVideo,
      replaceTrack: vi.fn(() => new Promise<void>(resolve => { finishReplace = resolve; })),
    };
    const publication = { source: Track.Source.ScreenShare, videoTrack: videoPublicationTrack, track: videoPublicationTrack };
    room.localParticipant.getTrackPublication.mockImplementation((source: Track.Source) =>
      source === Track.Source.ScreenShare ? publication : undefined);
    useVoiceStore.setState({ isScreenSharing: true });
    const oldConfig = useVoiceStore.getState().screenShareConfig;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const replacing = replaceScreenShare(room, makeStream(nextVideo), {
      config: { ...oldConfig, height: 720 },
    });
    await vi.waitFor(() => expect(videoPublicationTrack.replaceTrack).toHaveBeenCalledOnce());

    await stopScreenShare(room);
    const currentConfig = restarted ? { ...oldConfig, fps: 45 } : oldConfig;
    if (restarted) useVoiceStore.setState({ isScreenSharing: true, screenShareConfig: currentConfig });
    finishReplace();

    await expect(replacing).resolves.toBe(false);
    expect(useVoiceStore.getState().isScreenSharing).toBe(restarted);
    expect(useVoiceStore.getState().screenShareConfig).toEqual(currentConfig);
    expect(videoPublicationTrack.replaceTrack).toHaveBeenCalledOnce();
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledOnce();
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(oldVideo.stop).toHaveBeenCalledOnce();
    expect(nextVideo.stop).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it('does not commit a replacement when sharing stops while new audio is publishing', async () => {
    const room = fakeRoom();
    const oldVideo = makeVideoTrack('old-video');
    const nextVideo = makeVideoTrack('next-video');
    const nextAudio = makeTrack('audio');
    const videoTrack = {
      mediaStreamTrack: oldVideo,
      replaceTrack: vi.fn(async (next: typeof oldVideo) => { videoTrack.mediaStreamTrack = next; }),
    };
    const publication = { source: Track.Source.ScreenShare, videoTrack, track: videoTrack };
    room.localParticipant.getTrackPublication.mockImplementation((source: Track.Source) =>
      source === Track.Source.ScreenShare ? publication : undefined);
    let finishAudio!: () => void;
    room.localParticipant.publishTrack.mockImplementation(() => new Promise<void>(resolve => { finishAudio = resolve; }));
    useVoiceStore.setState({ isScreenSharing: true });
    const oldConfig = useVoiceStore.getState().screenShareConfig;
    const replacing = replaceScreenShare(room, makeStream(nextVideo, nextAudio), {
      config: { ...oldConfig, height: 720, shareAudio: true },
    });
    await vi.waitFor(() => expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce());

    await stopScreenShare(room);
    finishAudio();

    await expect(replacing).resolves.toBe(false);
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(useVoiceStore.getState().screenShareConfig).toEqual(oldConfig);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(nextAudio, false);
    expect(videoTrack.replaceTrack).toHaveBeenCalledOnce();
    expect(oldVideo.stop).toHaveBeenCalledOnce();
    expect(nextVideo.stop).toHaveBeenCalledOnce();
    expect(nextAudio.stop).toHaveBeenCalledOnce();
  });

  it('rolls video back if replacing staged audio fails after video already switched', async () => {
    const room = fakeRoom();
    const oldVideo = makeVideoTrack('old-video');
    const nextVideo = makeVideoTrack('next-video');
    const oldAudio = makeTrack('audio');
    const nextAudio = makeTrack('audio');
    const videoPublicationTrack = {
      mediaStreamTrack: oldVideo,
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    };
    const audioPublicationTrack = {
      mediaStreamTrack: oldAudio,
      replaceTrack: vi.fn().mockRejectedValue(new Error('audio replace failed')),
    };
    const videoPublication = { source: Track.Source.ScreenShare, videoTrack: videoPublicationTrack };
    const audioPublication = { source: Track.Source.ScreenShareAudio, audioTrack: audioPublicationTrack };
    room.localParticipant.getTrackPublication.mockImplementation((source: Track.Source) =>
      source === Track.Source.ScreenShare ? videoPublication : audioPublication);
    useVoiceStore.setState({ isScreenSharing: true });
    const oldConfig = useVoiceStore.getState().screenShareConfig;
    const nextConfig = { ...oldConfig, height: 720, shareAudio: true };

    await expect(replaceScreenShare(room, makeStream(nextVideo, nextAudio), { config: nextConfig }))
      .resolves.toBe(false);

    expect(videoPublicationTrack.replaceTrack).toHaveBeenNthCalledWith(1, nextVideo, { userProvidedTrack: true });
    expect(videoPublicationTrack.replaceTrack).toHaveBeenNthCalledWith(2, oldVideo, { userProvidedTrack: true });
    expect(audioPublicationTrack.replaceTrack).toHaveBeenCalledOnce();
    expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(videoPublication);
    expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBe(audioPublication);
    expect(useVoiceStore.getState().screenShareConfig).toEqual(oldConfig);
    expect(oldVideo.stop).not.toHaveBeenCalled();
    expect(oldAudio.stop).not.toHaveBeenCalled();
    expect(nextVideo.stop).toHaveBeenCalledOnce();
    expect(nextAudio.stop).toHaveBeenCalledOnce();
  });

  it('applies bitrate when the browser rejects RTP priority changes', async () => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    const sender = attachPublishedSender(room, video, []);
    sender.getParameters.mockImplementation(() => ({ encodings: [{ active: true, priority: 'low' }] }));
    sender.setParameters.mockRejectedValueOnce(new DOMException('priority unsupported', 'OperationError'));

    const applied = await applyOverdrive(room, Track.Source.ScreenShare, {
      maxBitrate: 3_000_000,
      maxFramerate: 30,
      degradationPreference: 'balanced',
    });

    expect(applied).toBe(true);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ priority: 'low', maxBitrate: 3_000_000, maxFramerate: 30 })],
    }));
  });

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
    expect(gaming.overdrive.degradationPreference).toBe('maintain-framerate');
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
      degradationPreference: 'maintain-framerate',
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

  it('migrates the old VP9 default to H.264 once and persists subsequent choices', async () => {
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
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');

    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
  });
});


it.each([
  ['gaming', 'maintain-framerate'],
  ['text', 'maintain-resolution'],
] as const)('publishes %s with the intended adaptation before sender retries', async (mode, preference) => {
  useVoiceStore.setState({ screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, mode } });
  const room = fakeRoom();
  const video = makeVideoTrack();
  expect(await publishScreenShare(room, makeStream(video))).toBe(true);
  expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(video, expect.objectContaining({
    source: Track.Source.ScreenShare,
    degradationPreference: preference,
  }));
  expect(buildScreenShareOptions(useVoiceStore.getState().screenShareConfig).overdrive.degradationPreference).toBe(preference);
});
