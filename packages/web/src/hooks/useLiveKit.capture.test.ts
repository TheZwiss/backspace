import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, RoomEvent, DisconnectReason } from 'livekit-client';
import { useLiveKit } from './useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';

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
vi.mock('../stores/spaceStore', () => ({
  getApiForOrigin: () => ({ livekit: { token: mocks.token, dmToken: mocks.token } }),
  getChannelOrigin: () => '', getMyUserIdForOrigin: () => 'me',
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
  mocks.disconnect.mockImplementation(async function (this: Room) {
    this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('voice capture teardown', () => {
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
