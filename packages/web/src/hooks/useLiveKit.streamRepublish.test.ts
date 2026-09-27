import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, RoomEvent, DisconnectReason, Track } from 'livekit-client';
import { useLiveKit } from './useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { STREAM_REPUBLISH_WINDOW_MS } from '../utils/streamRepublish';
import { SoundController } from '../components/voice/SoundController';
import type { User } from '@backspace/shared';

/**
 * A codec change on the sharer's side unpublishes the screen share and
 * publishes it again (#315). The sharer announces that on the data channel
 * first; a viewer that was watching picks the new track up by itself, and
 * nobody hears the share end and start again. A sharer that never announces
 * (an older client) must behave exactly as before: the share ends.
 */

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  connect: vi.fn(), disconnect: vi.fn(),
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
    dmChannels: [] as { id: string; members: { id: string; homeUserId?: string }[] }[],
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
  useSpaceStore: { getState: () => mocks.space },
}));

const SHARER = 'bob:Bob';

interface FakePublication {
  source: Track.Source;
  trackSid: string;
  track: undefined;
  isMuted: boolean;
  isSubscribed: boolean;
  setSubscribed: ReturnType<typeof vi.fn>;
}

function makePublication(source: Track.Source, trackSid: string): FakePublication {
  return { source, trackSid, track: undefined, isMuted: false, isSubscribed: false, setSubscribed: vi.fn() };
}

function makeSharer(room: Room, identity = SHARER) {
  const trackPublications = new Map<string, FakePublication>();
  const participant = { identity, trackPublications, isMicrophoneEnabled: true, isCameraEnabled: false };
  (room.remoteParticipants as Map<string, unknown>).set(identity, participant);
  return participant;
}

type Sharer = ReturnType<typeof makeSharer>;

function publish(room: Room, sharer: Sharer, trackSid: string): FakePublication {
  const pub = makePublication(Track.Source.ScreenShare, trackSid);
  sharer.trackPublications.set(trackSid, pub);
  act(() => { room.emit(RoomEvent.TrackPublished, pub as never, sharer as never); });
  return pub;
}

function unpublish(room: Room, sharer: Sharer, pub: FakePublication): void {
  sharer.trackPublications.delete(pub.trackSid);
  act(() => { room.emit(RoomEvent.TrackUnpublished, pub as never, sharer as never); });
}

function announceRepublish(room: Room, sharer: Sharer): void {
  const payload = new TextEncoder().encode(JSON.stringify({ type: 'stream_republish' }));
  act(() => { room.emit(RoomEvent.DataReceived, payload, sharer as never); });
}

function sharerIsListedAsSharing(identity = SHARER): boolean {
  return useVoiceStore.getState().participants.find((p) => p.identity === identity)?.isScreenSharing ?? false;
}

/** Every value `isScreenSharing` took for the sharer across store updates. */
function recordSharingFlag(identity = SHARER): boolean[] {
  const seen: boolean[] = [];
  useVoiceStore.subscribe((state) => {
    const p = state.participants.find((x) => x.identity === identity);
    if (p) seen.push(p.isScreenSharing);
  });
  return seen;
}

async function connectedRoom(): Promise<Room> {
  const { result } = renderHook(() => useLiveKit());
  await act(async () => { await result.current.connect('channel'); });
  return result.current.room!;
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
  mocks.space.dmChannels = [];
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), isMuted: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a viewer watching a share that is republished', () => {
  it('keeps watching and subscribes the new track', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    useVoiceStore.getState().setStreamVolume('bob', 150);

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(true);

    const second = publish(room, sharer, 'TR_2');
    expect(second.setSubscribed).toHaveBeenCalledWith(true);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(true);
    expect(useVoiceStore.getState().streamVolumes.get('bob')).toBe(150);
  });

  it('never lists the share as ended, so no stream_ended / stream_started cue fires', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    const seen = recordSharingFlag();

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    publish(room, sharer, 'TR_2');

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(false);
  });

  it('resumes when the new publication arrives in the same update as the removal', async () => {
    // livekit-client adds new publications before it emits removals, so the
    // new track already exists when TrackUnpublished for the old one fires.
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');

    announceRepublish(room, sharer);
    const second = makePublication(Track.Source.ScreenShare, 'TR_2');
    sharer.trackPublications.set('TR_2', second);
    unpublish(room, sharer, first);
    act(() => { room.emit(RoomEvent.TrackPublished, second as never, sharer as never); });

    expect(second.setSubscribed).toHaveBeenCalledWith(true);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(true);
  });

  it('does not subscribe the new track for a viewer who was not watching', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    const second = publish(room, sharer, 'TR_2');

    expect(second.setSubscribed).not.toHaveBeenCalled();
    expect(sharerIsListedAsSharing()).toBe(true);
  });

  it('ends the share as today when no new track arrives within the window', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    vi.useFakeTimers();

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    act(() => { vi.advanceTimersByTime(STREAM_REPUBLISH_WINDOW_MS - 1); });
    expect(sharerIsListedAsSharing()).toBe(true);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(true);

    act(() => { vi.advanceTimersByTime(1); });
    expect(sharerIsListedAsSharing()).toBe(false);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(false);

    // A share started later is a new share: it is not watched unasked.
    const later = publish(room, sharer, 'TR_3');
    expect(later.setSubscribed).not.toHaveBeenCalled();
  });

  it('ends the share when the sharer leaves while the new track is pending', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    (room.remoteParticipants as Map<string, unknown>).delete(SHARER);
    act(() => { room.emit(RoomEvent.ParticipantDisconnected, sharer as never); });

    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(false);
  });
});

describe('a sharer that does not announce the republish (older client)', () => {
  it('ends the share and does not watch the new track, as before', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    const seen = recordSharingFlag();

    unpublish(room, sharer, first);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(false);
    expect(seen).toContain(false);

    const second = publish(room, sharer, 'TR_2');
    expect(second.setSubscribed).not.toHaveBeenCalled();
  });

  it('treats an announcement that arrives after the removal as nothing', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');

    unpublish(room, sharer, first);
    announceRepublish(room, sharer);
    expect(sharerIsListedAsSharing()).toBe(false);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(false);

    const second = publish(room, sharer, 'TR_2');
    expect(second.setSubscribed).not.toHaveBeenCalled();
  });
});

describe('federated DM call: the stream is keyed by the local id of the sharer', () => {
  // updateParticipants resolves a federated member's LiveKit identity (their
  // home id) to the DM member's local id, and StreamTile watches by that id.
  beforeEach(() => {
    mocks.space.dmChannels = [{ id: 'dm', members: [{ id: 'local-bob', homeUserId: 'bob' }] }];
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'dm' } as never });
  });

  it('resumes the watch the tile started under the local id', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    expect(useVoiceStore.getState().participants.find((p) => p.identity === SHARER)?.userId).toBe('local-bob');
    useVoiceStore.getState().watchStream('local-bob');

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    const second = publish(room, sharer, 'TR_2');

    expect(second.setSubscribed).toHaveBeenCalledWith(true);
    expect(useVoiceStore.getState().watchingStreams.has('local-bob')).toBe(true);
  });

  it('ends the watch the tile started under the local id when the share ends', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('local-bob');

    unpublish(room, sharer, first);

    expect(useVoiceStore.getState().watchingStreams.has('local-bob')).toBe(false);
  });
});

describe('viewer-side cues across a republish', () => {
  async function viewerWithSounds() {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    useAuthStore.setState({ user: { id: 'me', status: 'online' } as User });
    vi.useFakeTimers();
    render(createElement(SoundController));
    act(() => { vi.advanceTimersByTime(1000); });
    mocks.audio.playSound.mockClear();
    return { room, sharer, first };
  }

  function cuesPlayed(): string[] {
    return mocks.audio.playSound.mock.calls.map(([name]) => name as string);
  }

  it('plays neither stream_ended nor stream_started', async () => {
    const { room, sharer, first } = await viewerWithSounds();

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    publish(room, sharer, 'TR_2');

    expect(cuesPlayed()).toEqual([]);
  });

  it('still plays stream_ended when the share really ends', async () => {
    const { room, sharer, first } = await viewerWithSounds();

    unpublish(room, sharer, first);

    expect(cuesPlayed()).toEqual(['stream_ended']);
  });
});
