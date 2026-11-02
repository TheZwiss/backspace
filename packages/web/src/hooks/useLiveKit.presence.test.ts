import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionState, DisconnectReason, Room, RoomEvent, Track } from 'livekit-client';
import { useLiveKit } from './useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import type { User } from '@backspace/shared';

const ORBIT = 'https://orbit.example';

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  connect: vi.fn(), disconnect: vi.fn(),
  origins: new Map<string, string>(),
  audio: {
    releaseInputStream: vi.fn(), resumeContext: vi.fn(),
    setTextInputOnly: vi.fn(), setVoiceProcessing: vi.fn(), setRnnoiseEnabled: vi.fn(),
    setInputDevice: vi.fn(), setInputVolume: vi.fn(),
    onResumed: vi.fn(() => vi.fn()), onInputTrackEnded: vi.fn(() => vi.fn()),
    getStreamGeneration: () => 1, getFreshTrack: () => null,
    playSound: vi.fn(),
  },
  space: {
    channelToSpaceMap: new Map<string, string>(),
    members: [] as unknown[],
    dmChannels: [] as unknown[],
  },
}));

vi.mock('livekit-client', async importOriginal => {
  const sdk = await importOriginal<typeof import('livekit-client')>();
  return {
    ...sdk,
    Room: class extends sdk.Room {
      connect = mocks.connect;
      disconnect = mocks.disconnect;
    },
  };
});
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => mocks.audio } }));
vi.mock('../audio/SpeakingDetector', () => ({
  SpeakingDetector: { getInstance: () => ({ clear: vi.fn(), syncTracks: vi.fn() }) },
}));
vi.mock('./useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../utils/voice', () => ({ broadcastVoiceStatus: vi.fn(), clearSpaceVoiceForDmCall: vi.fn() }));
vi.mock('../utils/hwOverdrive', () => ({ activate: vi.fn(), deactivate: vi.fn() }));
vi.mock('../stores/spaceStore', () => ({
  getApiForOrigin: () => ({ livekit: { token: mocks.token, dmToken: mocks.token } }),
  getChannelOrigin: (channelId: string) => mocks.origins.get(channelId) ?? '',
  getMyUserIdForOrigin: () => 'local-user',
  useSpaceStore: { getState: () => mocks.space },
}));

const me = { id: 'local-user', username: 'local', displayName: 'Local', homeInstance: null, homeUserId: null } as unknown as User;

function member(userId: string, username: string, spaceId = 'space-1') {
  return {
    id: userId,
    userId,
    spaceId,
    user: { id: userId, username, displayName: username, homeUserId: null },
  };
}

async function connectTo(channelId = 'channel', isDm = false) {
  const { result } = renderHook(() => useLiveKit());
  await act(async () => { await result.current.connect(channelId, isDm); });
  return { result, room: result.current.room! };
}

function remoteParticipant(identity: string, cameraTrack?: MediaStreamTrack) {
  const trackPublications = new Map<string, unknown>();
  if (cameraTrack) {
    trackPublications.set('camera', {
      source: Track.Source.Camera,
      isMuted: false,
      isSubscribed: true,
      track: { mediaStreamTrack: cameraTrack },
    });
  }
  return {
    identity,
    trackPublications,
    isMicrophoneEnabled: true,
    isCameraEnabled: !!cameraTrack,
  };
}

function remoteRows() {
  return useVoiceStore.getState().participants.filter(participant => !participant.isLocal);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.origins.clear();
  mocks.token.mockResolvedValue({ token: 'test', url: 'wss://example.invalid' });
  mocks.audio.resumeContext.mockResolvedValue(undefined);
  mocks.audio.setRnnoiseEnabled.mockResolvedValue(undefined);
  mocks.audio.setInputDevice.mockResolvedValue(null);
  mocks.connect.mockImplementation(async function (this: Room) {
    Object.defineProperty(this, 'state', { configurable: true, value: ConnectionState.Connected });
  });
  mocks.disconnect.mockImplementation(async function (this: Room) {
    Object.defineProperty(this, 'state', { configurable: true, value: ConnectionState.Disconnected });
    this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
  });
  mocks.space.channelToSpaceMap = new Map([['channel', 'space-1'], ['channel-2', 'space-1']]);
  mocks.space.members = [member('remote-1', 'Alice'), member('remote-2', 'Bob')];
  mocks.space.dmChannels = [];
  useVoiceStore.setState({
    ...useVoiceStore.getInitialState(),
    currentVoiceChannelId: 'channel',
    voiceConnectionStatus: 'connected',
    voiceUsers: new Map(),
  });
  useAuthStore.setState({ user: me, myRowIds: new Map([[ORBIT, 'orbit-local']]) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, myRowIds: new Map() });
});

describe('LiveKit participant presence fallback', () => {
  it('shows a WS join before LiveKit arrival, then reconciles it with one SDK-backed row', async () => {
    mocks.origins.set('channel', ORBIT);
    const { room } = await connectTo();

    act(() => { useVoiceStore.getState().addVoiceUser('channel', 'remote-1'); });
    await waitFor(() => expect(remoteRows().map(row => row.userId)).toEqual(['remote-1']));
    const placeholder = remoteRows()[0]!;
    expect(placeholder.identity).toBe('remote-1:Alice');
    expect(placeholder.videoTrack).toBeNull();
    expect(placeholder.audioTrack).toBeNull();
    expect(placeholder.screenTrack).toBeNull();
    expect(placeholder.screenAudioTrack).toBeNull();
    expect(placeholder.isCameraOn).toBe(false);
    expect(placeholder.isScreenSharing).toBe(false);

    const cameraTrack = { kind: 'video', readyState: 'live', id: 'camera-live' } as unknown as MediaStreamTrack;
    const participant = remoteParticipant('remote-1:Alice', cameraTrack);
    (room.remoteParticipants as Map<string, unknown>).set(participant.identity, participant);
    act(() => { room.emit(RoomEvent.ParticipantConnected, participant as never); });

    await waitFor(() => expect(remoteRows()).toHaveLength(1));
    expect(remoteRows()[0]?.userId).toBe('remote-1');
    expect(remoteRows()[0]?.videoTrack).toBe(cameraTrack);
    expect(remoteRows()[0]?.isCameraOn).toBe(true);
  });

  it('removes a WS-only fallback row immediately on voice leave', async () => {
    await connectTo();
    act(() => { useVoiceStore.getState().addVoiceUser('channel', 'remote-1'); });
    await waitFor(() => expect(remoteRows()).toHaveLength(1));

    act(() => { useVoiceStore.getState().removeVoiceUser('channel', 'remote-1'); });

    await waitFor(() => expect(remoteRows()).toHaveLength(0));
  });

  it('removes a confirmed departure before the SDK removes its participant and accepts a quick rejoin', async () => {
    const { room } = await connectTo();
    const participant = remoteParticipant('remote-1:Alice');
    (room.remoteParticipants as Map<string, unknown>).set(participant.identity, participant);
    act(() => {
      useVoiceStore.getState().addVoiceUser('channel', 'remote-1');
      room.emit(RoomEvent.ParticipantConnected, participant as never);
    });
    await waitFor(() => expect(remoteRows()).toHaveLength(1));

    act(() => { useVoiceStore.getState().removeVoiceUser('channel', 'remote-1'); });
    await waitFor(() => expect(remoteRows()).toHaveLength(0));
    expect(room.remoteParticipants.has(participant.identity)).toBe(true);
    act(() => { room.emit(RoomEvent.ParticipantMetadataChanged, undefined, participant as never); });
    expect(remoteRows()).toHaveLength(0);

    act(() => { useVoiceStore.getState().addVoiceUser('channel', 'remote-1'); });
    await waitFor(() => expect(remoteRows()).toHaveLength(1));
    (room.remoteParticipants as Map<string, unknown>).delete(participant.identity);
    act(() => { room.emit(RoomEvent.ParticipantDisconnected, participant as never); });
    await waitFor(() => expect(remoteRows()).toHaveLength(1));
    expect(remoteRows()[0]?.userId).toBe('remote-1');

    (room.remoteParticipants as Map<string, unknown>).set(participant.identity, participant);
    act(() => { room.emit(RoomEvent.ParticipantConnected, participant as never); });
    expect(remoteRows()).toHaveLength(1);
  });

  it('does not hide SDK participants without an explicit departure or on another channel leave', async () => {
    const { room } = await connectTo();
    const participant = remoteParticipant('remote-1:Alice');
    (room.remoteParticipants as Map<string, unknown>).set(participant.identity, participant);
    act(() => { room.emit(RoomEvent.ParticipantConnected, participant as never); });
    expect(remoteRows()).toHaveLength(1);

    act(() => { useVoiceStore.getState().removeVoiceUser('channel-2', 'remote-1'); });
    expect(remoteRows()).toHaveLength(1);
  });

  it('does not include people listed only in another channel', async () => {
    await connectTo();
    act(() => { useVoiceStore.getState().addVoiceUser('channel-2', 'remote-2'); });

    expect(remoteRows()).toHaveLength(0);
  });

  it('does not create fallback rows for a DM room', async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: null,
      activeDmCall: {
        dmChannelId: 'dm-1',
        federatedCallId: null,
        callOrigin: null,
        livekit: null,
      },
    });
    const { result } = await connectTo('dm-1', true);
    expect(result.current.room).not.toBeNull();
    act(() => { useVoiceStore.getState().addVoiceUser('dm-1', 'remote-1'); });

    expect(remoteRows()).toHaveLength(0);
  });

  it('does not retain fallback rows after disconnect', async () => {
    const { result } = await connectTo();
    act(() => { useVoiceStore.getState().addVoiceUser('channel', 'remote-1'); });
    await waitFor(() => expect(remoteRows()).toHaveLength(1));

    await act(async () => { await result.current.disconnect(); });

    expect(useVoiceStore.getState().participants).toEqual([]);
  });

  it('uses only the newly active room after a session changes channels', async () => {
    const { result } = await connectTo();
    act(() => { useVoiceStore.getState().addVoiceUser('channel', 'remote-1'); });
    await waitFor(() => expect(remoteRows().map(row => row.userId)).toEqual(['remote-1']));

    useVoiceStore.setState({ currentVoiceChannelId: 'channel-2' });
    act(() => { useVoiceStore.getState().addVoiceUser('channel-2', 'remote-2'); });
    await act(async () => { await result.current.connect('channel-2'); });

    await waitFor(() => expect(remoteRows().map(row => row.userId)).toEqual(['remote-2']));
  });
});
