import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, RoomEvent, DisconnectReason } from 'livekit-client';
import { useLiveKit } from './useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { isMe, useAuthStore } from '../stores/authStore';
import type { User } from '@backspace/shared';

/**
 * The local participant's fallback row (no member row lists the user) is the
 * user's row as the instance hosting the call issues it:
 * `useVoiceParticipantMeta` reads it with that origin.
 */

const ORBIT = 'https://orbit.example';

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  connect: vi.fn(), disconnect: vi.fn(),
  origin: '',
  audio: {
    releaseInputStream: vi.fn(), resumeContext: vi.fn(),
    setVoiceProcessing: vi.fn(), setRnnoiseEnabled: vi.fn(),
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
vi.mock('../utils/hwOverdrive', () => ({ activate: vi.fn(), deactivate: vi.fn() }));
vi.mock('../stores/spaceStore', () => ({
  getApiForOrigin: () => ({ livekit: { token: mocks.token, dmToken: mocks.token } }),
  getChannelOrigin: () => mocks.origin,
  getMyUserIdForOrigin: () => undefined,
  useSpaceStore: { getState: () => mocks.space },
}));

const me = { id: 'n-1', username: 'jannis', displayName: 'Jannis', homeInstance: null, homeUserId: null } as unknown as User;

async function listedLocalRow(identity: string): Promise<User | null | undefined> {
  const { result } = renderHook(() => useLiveKit());
  await act(async () => { await result.current.connect('channel'); });
  const room = result.current.room!;
  (room.localParticipant as { identity: string }).identity = identity;
  act(() => { room.emit(RoomEvent.ParticipantMetadataChanged, undefined, room.localParticipant); });
  return useVoiceStore.getState().participants.find((p) => p.identity === identity)?.cachedUser;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.mockResolvedValue({ token: 'test', url: 'wss://example.invalid' });
  mocks.audio.resumeContext.mockResolvedValue(undefined);
  mocks.audio.setRnnoiseEnabled.mockResolvedValue(undefined);
  mocks.audio.setInputDevice.mockResolvedValue(null);
  mocks.connect.mockResolvedValue(undefined);
  mocks.disconnect.mockImplementation(async function (this: Room) {
    this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
  });
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), isMuted: false, currentVoiceChannelId: 'channel' });
  useAuthStore.setState({ user: me, myRowIds: new Map([[ORBIT, 'o-7']]) });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, myRowIds: new Map() });
});

describe('the local participant row', () => {
  it("is the user's row on the instance hosting the call", async () => {
    mocks.origin = ORBIT;
    const row = await listedLocalRow('o-7:jannis');
    expect(row?.id).toBe('o-7');
    expect(isMe(row!, ORBIT)).toBe(true);
  });

  it("is the session row on the page's own instance", async () => {
    mocks.origin = '';
    expect(await listedLocalRow('n-1:jannis')).toBe(me);
  });
});
