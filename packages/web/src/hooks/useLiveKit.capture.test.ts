import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, RoomEvent, DisconnectReason, ConnectionState, Track, TrackEvent } from 'livekit-client';
import { useLiveKit } from './useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { useSettingsStore } from '../stores/settingsStore';

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  connect: vi.fn(), disconnect: vi.fn(),
  audio: {
    releaseInputStream: vi.fn(), resumeContext: vi.fn(),
    setVoiceProcessing: vi.fn(), setRnnoiseEnabled: vi.fn(),
    setInputDevice: vi.fn(), setInputVolume: vi.fn(),
    onResumed: vi.fn(() => vi.fn()), onInputTrackEnded: vi.fn(() => vi.fn()),
    getStreamGeneration: () => 1, getFreshTrack: () => null,
  },
  scheduleScreenShareOverdrive: vi.fn(),
  syncScreenShareAudio: vi.fn(),
  applyOverdrive: vi.fn(),
  channelOrigin: vi.fn<(channelId: string) => string>(() => ''),
}));
vi.mock('livekit-client', async importOriginal => {
  const sdk = await importOriginal<typeof import('livekit-client')>();
  return { ...sdk, Room: class extends sdk.Room {
    connect = mocks.connect;
    disconnect = mocks.disconnect;
  } };
});
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => mocks.audio } }));
vi.mock('../audio/SpeakingDetector', () => ({
  SpeakingDetector: { getInstance: () => ({ clear: vi.fn(), syncTracks: vi.fn() }) },
}));
vi.mock('./useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../utils/voice', () => ({ broadcastVoiceStatus: vi.fn(), clearSpaceVoiceForDmCall: vi.fn() }));
vi.mock('../utils/hwOverdrive', () => ({ deactivate: vi.fn() }));
vi.mock('../utils/screenShare', async importOriginal => {
  const original = await importOriginal<typeof import('../utils/screenShare')>();
  return {
    ...original,
    scheduleScreenShareOverdrive: mocks.scheduleScreenShareOverdrive,
    syncScreenShareAudio: mocks.syncScreenShareAudio,
    applyOverdrive: mocks.applyOverdrive,
  };
});
vi.mock('../stores/spaceStore', () => ({
  getApiForOrigin: () => ({ livekit: { token: mocks.token, dmToken: mocks.token } }),
  getChannelOrigin: (channelId: string) => mocks.channelOrigin(channelId), getMyUserIdForOrigin: () => 'me',
  useSpaceStore: { getState: () => ({ channelToSpaceMap: new Map(), members: [], dmChannels: [] }) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.mockResolvedValue({ token: 'test', url: 'wss://example.invalid' });
  mocks.audio.resumeContext.mockResolvedValue(undefined);
  mocks.audio.setRnnoiseEnabled.mockResolvedValue(undefined);
  mocks.audio.setInputDevice.mockResolvedValue(null);
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), isMuted: false });
  mocks.connect.mockResolvedValue(undefined);
  mocks.channelOrigin.mockReturnValue('');
  mocks.syncScreenShareAudio.mockResolvedValue(undefined);
  mocks.applyOverdrive.mockResolvedValue(true);
  mocks.disconnect.mockImplementation(async function (this: Room) {
    this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('voice capture teardown', () => {
  it('preserves voice intent across Reconnecting → Connected', async () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const leaveSpy = vi.spyOn(useVoiceStore.getState(), 'leaveVoice');
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });

    act(() => { result.current.room!.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting); });
    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('reconnecting');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel');

    act(() => { result.current.room!.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected); });
    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('connected');
    expect(leaveSpy).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel');
  });

  it('uses the bounded screen-share sender scheduler after reconnect and track restart', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    useVoiceStore.setState({ isScreenSharing: true });

    act(() => {
      result.current.room!.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);
      result.current.room!.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
    });
    expect(mocks.scheduleScreenShareOverdrive).toHaveBeenCalledOnce();

    let restart!: () => void;
    const track = {
      on: vi.fn((event: TrackEvent, handler: () => void) => {
        if (event === TrackEvent.Restarted) restart = handler;
      }),
    };
    act(() => {
      result.current.room!.emit(RoomEvent.LocalTrackPublished, {
        source: Track.Source.ScreenShare,
        track,
      } as never);
      restart();
    });

    expect(track.on).toHaveBeenCalledWith(TrackEvent.Restarted, expect.any(Function));
    expect(mocks.scheduleScreenShareOverdrive).toHaveBeenCalledTimes(2);
  });

  it('clears voice intent for a terminal semantic disconnect', async () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });

    act(() => { result.current.room!.emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED); });

    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('disconnected');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
  });

  it('reports initial connect failure after the SDK emits Disconnected', async () => {
    mocks.connect.mockImplementationOnce(async function (this: Room) {
      this.emit(RoomEvent.Disconnected, DisconnectReason.JOIN_FAILURE);
      throw new Error('connection rejected');
    });
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    expect(result.current.connectionError).toBe('connect_failed');
    expect(useVoiceStore.getState().connectionError).toBe('connect_failed');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
    expect(result.current.isConnecting).toBe(false);
    expect(result.current.isConnected).toBe(false);
  });
  it('clears connecting state and ignores a late token after leave', async () => {
    let finish!: (token: { token: string; url: string }) => void;
    mocks.token.mockReturnValueOnce(new Promise(r => { finish = r; }));
    const { result } = renderHook(() => useLiveKit());
    let connecting!: Promise<void>;
    await act(async () => { connecting = result.current.connect('channel'); });
    expect(result.current.isConnecting).toBe(true);
    await act(async () => { await result.current.disconnect(); });
    expect(result.current.isConnecting).toBe(false);
    await act(async () => { finish({ token: 'late', url: 'wss://example.invalid' }); await connecting; });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
  });

  it('releases once on connected unmount despite the SDK disconnected event', async () => {
    const { result, unmount } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    unmount();
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not publish a late acquisition into the room that was left', async () => {
    let finish!: () => void;
    mocks.audio.setInputDevice.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    await act(async () => { await result.current.disconnect(); });
    await act(async () => { finish(); });
    expect(mocks.audio.setInputVolume).not.toHaveBeenCalled();
  });

  it('releases pre-armed capture even when no Room exists', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.disconnect(); });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
  });

  it('releases before awaiting SDK teardown', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    let finish!: () => void;
    mocks.disconnect.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    let leaving!: Promise<void>;
    act(() => { leaving = result.current.disconnect(); });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await leaving; });
  });

  it.each([DisconnectReason.PARTICIPANT_REMOVED, undefined])('releases on a terminal room event (%s)', async reason => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    act(() => { result.current.room!.emit(RoomEvent.Disconnected, reason); });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
  });

  it('retains voice intent and exposes retry after an exhausted network reconnect', async () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });

    act(() => { result.current.room!.emit(RoomEvent.Disconnected, undefined); });

    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel');
    expect(result.current.connectionError).toBe('network_disconnect');
    expect(useVoiceStore.getState().connectionError).toBe('network_disconnect');
    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('disconnected');
  });

  it('keeps capture warm while switching channels and ignores stale room events', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('first'); });
    const oldRoom = result.current.room!;
    await act(async () => { await result.current.connect('second'); });
    act(() => { oldRoom.emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED); });
    expect(mocks.audio.releaseInputStream).not.toHaveBeenCalled();
    expect(result.current.connectedChannelId).toBe('second');
  });

  it('releases pre-armed capture when the token request fails', async () => {
    mocks.token.mockRejectedValueOnce(new Error('token unavailable'));
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
  });

  it('releases on unmount before a Room exists and cancels pending connect', async () => {
    let finish!: () => void;
    mocks.audio.resumeContext.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    const { result, unmount } = renderHook(() => useLiveKit());
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.connect('channel'); });
    unmount();
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await connecting; });
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it('does not reacquire after leaving during noise-suppressor initialization', async () => {
    let finish!: () => void;
    mocks.audio.setRnnoiseEnabled.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    await act(async () => { await result.current.disconnect(); });
    await act(async () => { finish(); });
    expect(mocks.audio.setInputDevice).not.toHaveBeenCalled();
  });

  it('does not let an old disconnect clear a new call after SDK teardown', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('first'); });
    let finish!: () => void;
    mocks.disconnect.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    let leaving!: Promise<void>;
    act(() => { leaving = result.current.disconnect(); });
    await act(async () => { await result.current.connect('second'); });
    await act(async () => { finish(); await leaving; });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.connectedChannelId).toBe('second');
  });
});

describe('screen-share audio published mid-stream', () => {
  // A streamer can turn System Audio on after starting (#301). Stream tracks
  // are only subscribed while watching, and the watch click subscribed the
  // publications that existed then, so an audio track published later stayed
  // unsubscribed and a viewer already watching never heard it.
  function publishFromRemote(room: Room, source: Track.Source, watching: boolean) {
    useVoiceStore.setState({ watchingStreams: new Set(watching ? ['u2'] : []) });
    const publication = { source, setSubscribed: vi.fn() };
    const participant = { identity: 'u2:Bob' };
    act(() => { room.emit(RoomEvent.TrackPublished, publication as never, participant as never); });
    return publication;
  }

  it('subscribes the audio for a viewer already watching that stream', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    const publication = publishFromRemote(result.current.room!, Track.Source.ScreenShareAudio, true);
    expect(publication.setSubscribed).toHaveBeenCalledWith(true);
  });

  it('applies a System Audio change to the live share', async () => {
    mocks.syncScreenShareAudio.mockResolvedValue(undefined);
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    await act(async () => { useVoiceStore.setState({ isScreenSharing: true }); });
    mocks.syncScreenShareAudio.mockClear();

    await act(async () => { useVoiceStore.getState().setScreenShareConfig({ shareAudio: false }); });

    expect(mocks.syncScreenShareAudio).toHaveBeenCalledWith(result.current.room);
  });

  it('leaves it alone for someone not watching', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    const publication = publishFromRemote(result.current.room!, Track.Source.ScreenShareAudio, false);
    expect(publication.setSubscribed).not.toHaveBeenCalled();
  });
});

describe('the instance hosting the call', () => {
  const REMOTE = 'https://remote.example';
  const limits = (maxBitrateKbps: number) => ({
    maxBitrateKbps, minBitrateKbps: 500, bitrateStepKbps: 500,
    allowedResolutions: [540, 720, 1080], allowedFramerates: [30, 45, 60],
    maxResolution: 1080, maxFramerate: 60, discoveryEnabled: true, directoryEnabled: false,
    directoryConfigured: false, bitrateMatrixOverrides: null, allowCustomBitrate: true,
  });

  it('records the origin that issued the token and asks it for its limits', async () => {
    mocks.channelOrigin.mockReturnValue(REMOTE);
    const fetchFor = vi.spyOn(useSettingsStore.getState(), 'fetchStreamingLimitsFor').mockResolvedValue(undefined);
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    expect(useVoiceStore.getState().livekitHostOrigin).toBe(REMOTE);
    expect(fetchFor).toHaveBeenCalledWith(REMOTE);
  });

  it('records a DM call on a remote origin as hosted there', async () => {
    mocks.channelOrigin.mockReturnValue(REMOTE);
    vi.spyOn(useSettingsStore.getState(), 'fetchStreamingLimitsFor').mockResolvedValue(undefined);
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('dm-1', true); });
    expect(useVoiceStore.getState().livekitHostOrigin).toBe(REMOTE);
  });

  it('records an unknown host for a token relayed from another instance', async () => {
    useVoiceStore.setState({ federatedCallToken: 'relayed', federatedCallUrl: 'wss://host.example/livekit' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('dm-1', true); });
    expect(useVoiceStore.getState().livekitHostOrigin).toBeNull();
  });

  it('re-applies the encoding when the host limits arrive after the share started', async () => {
    mocks.channelOrigin.mockReturnValue(REMOTE);
    vi.spyOn(useSettingsStore.getState(), 'fetchStreamingLimitsFor').mockResolvedValue(undefined);
    useSettingsStore.setState({ streamingLimitsByOrigin: {} });
    useVoiceStore.setState({
      screenShareConfig: { height: 1080, fps: 60, mode: 'gaming', customBitrateKbps: null, shareAudio: false, codec: 'vp9' },
    });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    const room = result.current.room!;
    const mediaStreamTrack = { applyConstraints: vi.fn().mockResolvedValue(undefined), contentHint: '', getSettings: () => ({}) };
    vi.spyOn(room.localParticipant, 'getTrackPublications').mockReturnValue([
      { source: Track.Source.ScreenShare, videoTrack: { mediaStreamTrack } },
    ] as never);
    await act(async () => { useVoiceStore.setState({ isScreenSharing: true }); });
    expect(mocks.applyOverdrive).toHaveBeenLastCalledWith(room, Track.Source.ScreenShare, expect.objectContaining({ maxBitrate: 8_000_000 }));

    await act(async () => { useSettingsStore.setState({ streamingLimitsByOrigin: { [REMOTE]: limits(3000) } }); });

    expect(mocks.applyOverdrive).toHaveBeenLastCalledWith(room, Track.Source.ScreenShare, expect.objectContaining({ maxBitrate: 3_000_000 }));
  });
});
