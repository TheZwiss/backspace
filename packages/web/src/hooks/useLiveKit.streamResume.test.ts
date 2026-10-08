import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, RoomEvent, DisconnectReason, Track, ConnectionState } from 'livekit-client';
import { useLiveKit } from './useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { STREAM_RESUME_WINDOW_MS } from '../utils/streamResume';
import { publishScreenShare, stopScreenShare } from '../utils/screenShare';
import { SoundController } from '../components/voice/SoundController';
import type { User } from '@backspace/shared';

/**
 * A full LiveKit reconnect drops the reconnecting participant for everyone
 * else and drops every remote participant on its own side (livekit-client
 * 2.22.3, Room.handleRestarting), so a watched share ends on the viewer
 * whichever side reconnects, with no chance to announce it first (#416).
 * The viewer remembers the share; after the sharer's reconnect the sharer
 * says the share is back (`stream_resume`), and after the viewer's own
 * reconnect the viewer watches again once the share is published.
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
vi.mock('../utils/hwOverdrive', () => ({ activate: vi.fn(), deactivate: vi.fn() }));
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

/**
 * A participant leaving, in livekit-client's order (Room.handleParticipantDisconnected):
 * dropped from remoteParticipants, then TrackUnpublished for each remaining
 * publication, then ParticipantDisconnected. The first TrackUnpublished's
 * update already removes the participant from the store's participant list.
 */
function leave(room: Room, sharer: Sharer): void {
  (room.remoteParticipants as Map<string, unknown>).delete(sharer.identity);
  for (const pub of [...sharer.trackPublications.values()]) unpublish(room, sharer, pub);
  act(() => { room.emit(RoomEvent.ParticipantDisconnected, sharer as never); });
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

function setState(room: Room, state: ConnectionState): void {
  (room as { state: ConnectionState }).state = state;
  act(() => { room.emit(RoomEvent.ConnectionStateChanged, state); });
}

function signal(room: Room, sharer: Sharer, type: 'stream_resume' | 'stream_stop'): void {
  const payload = new TextEncoder().encode(JSON.stringify({ type }));
  act(() => { room.emit(RoomEvent.DataReceived, payload, sharer as never); });
}

/** The pings this client sent on the data channel. */
function sentPings(room: Room): unknown[] {
  return vi.mocked(room.localParticipant.publishData).mock.calls
    .map(([data]) => JSON.parse(new TextDecoder().decode(data as Uint8Array)) as unknown);
}

async function viewerRoom(): Promise<Room> {
  const room = await connectedRoom();
  (room as { state: ConnectionState }).state = ConnectionState.Connected;
  vi.spyOn(room.localParticipant, 'publishData').mockResolvedValue(undefined);
  return room;
}

/** The sharer comes back as a new participant under the same identity, sharing. */
function rejoinSharing(room: Room, trackSid: string): { sharer: Sharer; pub: FakePublication } {
  const sharer = makeSharer(room);
  act(() => { room.emit(RoomEvent.ParticipantConnected, sharer as never); });
  return { sharer, pub: publish(room, sharer, trackSid) };
}

describe('a viewer watching a share whose sharer fully reconnects', () => {
  async function watching() {
    const room = await viewerRoom();
    const sharer = makeSharer(room);
    publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    useVoiceStore.getState().setStreamVolume('bob', 150);
    useVoiceStore.getState().setStreamMute('bob', true);
    // The sharer's reconnect: the server replaces it, so it leaves.
    leave(room, sharer);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(false);
    return room;
  }

  it('watches again, with its volume and mute, once the sharer says the share is back', async () => {
    const room = await watching();
    const { sharer, pub } = rejoinSharing(room, 'TR_2');
    expect(pub.setSubscribed).not.toHaveBeenCalled();

    signal(room, sharer, 'stream_resume');

    expect(pub.setSubscribed).toHaveBeenCalledWith(true);
    const state = useVoiceStore.getState();
    expect(state.watchingStreams.has('bob')).toBe(true);
    expect(state.streamVolumes.get('bob')).toBe(150);
    expect(state.streamMutes.get('bob')).toBe(true);
    // Back in the sharer's watcher set, which its reconnect may have emptied.
    expect(sentPings(room)).toEqual([{ type: 'stream_watch', target: 'bob', targetIdentity: SHARER, watching: true }]);
  });

  it('watches again when the message arrives before the publication', async () => {
    const room = await watching();
    const sharer = makeSharer(room);
    signal(room, sharer, 'stream_resume');

    const pub = publish(room, sharer, 'TR_2');

    expect(pub.setSubscribed).toHaveBeenCalledWith(true);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(true);
  });

  it('does not watch a share the viewer was not watching', async () => {
    const room = await viewerRoom();
    const sharer = makeSharer(room);
    publish(room, sharer, 'TR_1');
    leave(room, sharer);

    const again = rejoinSharing(room, 'TR_2');
    signal(room, again.sharer, 'stream_resume');

    expect(again.pub.setSubscribed).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(false);
  });

  it('forgets the share once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const room = await watching();
    act(() => { vi.advanceTimersByTime(STREAM_RESUME_WINDOW_MS); });

    const { sharer, pub } = rejoinSharing(room, 'TR_2');
    signal(room, sharer, 'stream_resume');

    expect(pub.setSubscribed).not.toHaveBeenCalled();
  });

  it('does not watch a new share started without a reconnect', async () => {
    // An older sharer, or a sharer that stopped without its stop reaching
    // this viewer: a new share is not watched unasked.
    const room = await watching();
    const { pub } = rejoinSharing(room, 'TR_2');

    expect(pub.setSubscribed).not.toHaveBeenCalled();
  });
});

describe('a share its sharer stopped', () => {
  it('is not remembered when the stop arrives before the removal', async () => {
    const room = await viewerRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');

    signal(room, sharer, 'stream_stop');
    unpublish(room, sharer, first);
    const second = publish(room, sharer, 'TR_2');
    signal(room, sharer, 'stream_resume');

    expect(second.setSubscribed).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(false);
  });

  it('is forgotten when the stop arrives after the removal', async () => {
    const room = await viewerRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');

    unpublish(room, sharer, first);
    signal(room, sharer, 'stream_stop');
    const second = publish(room, sharer, 'TR_2');
    signal(room, sharer, 'stream_resume');

    expect(second.setSubscribed).not.toHaveBeenCalled();
  });
});

describe('a viewer whose own connection fully reconnects', () => {
  // Room.handleRestarting: every remote participant is dropped first, then
  // the room goes Reconnecting; the join response brings them back before
  // Connected, and their TrackPublished events follow Connected.

  it('watches the share again once the room is back, without the sharer saying anything', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const room = await viewerRoom();
    const sharer = makeSharer(room);
    publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    useVoiceStore.getState().setStreamVolume('bob', 60);

    leave(room, sharer);
    setState(room, ConnectionState.Reconnecting);
    // A reconnect may outlast the window; the memory waits for it.
    act(() => { vi.advanceTimersByTime(STREAM_RESUME_WINDOW_MS * 2); });
    const back = makeSharer(room);
    const pub = makePublication(Track.Source.ScreenShare, 'TR_1');
    back.trackPublications.set('TR_1', pub);
    setState(room, ConnectionState.Connected);

    expect(pub.setSubscribed).toHaveBeenCalledWith(true);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(true);
    expect(useVoiceStore.getState().streamVolumes.get('bob')).toBe(60);
    expect(sentPings(room)).toEqual([expect.objectContaining({ type: 'stream_watch', targetIdentity: SHARER, watching: true })]);
  });

  it('watches the share when its publication arrives after Connected', async () => {
    const room = await viewerRoom();
    const sharer = makeSharer(room);
    publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');

    leave(room, sharer);
    setState(room, ConnectionState.Reconnecting);
    setState(room, ConnectionState.Connected);
    const { pub } = rejoinSharing(room, 'TR_1');

    expect(pub.setSubscribed).toHaveBeenCalledWith(true);
  });
});

describe('the sharer\'s own full reconnect', () => {
  const ME = 'me:Me';
  const ANN = 'ann:Ann';
  const CAL = 'cal:Cal';

  interface LocalPub { source: Track.Source; trackSid: string; track: { mediaStreamTrack: MediaStreamTrack; on: () => void }; isMuted: boolean }

  beforeEach(() => {
    (globalThis as { MediaStream?: unknown }).MediaStream = class {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
      getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    };
    useVoiceStore.setState({
      screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, codec: 'vp9', shareAudio: false },
    });
  });

  function cuesPlayed(): string[] {
    return mocks.audio.playSound.mock.calls.map(([name]) => name as string);
  }

  function viewer(room: Room, identity: string) {
    const p = { identity, trackPublications: new Map(), isMicrophoneEnabled: true, isCameraEnabled: false };
    (room.remoteParticipants as Map<string, unknown>).set(identity, p);
    const ping = new TextEncoder().encode(JSON.stringify({ type: 'stream_watch', target: 'me', targetIdentity: ME, watching: true }));
    act(() => { room.emit(RoomEvent.DataReceived, ping, p as never); });
    return p;
  }

  async function sharingTo(identities: string[]) {
    const room = await connectedRoom();
    (room as { state: ConnectionState }).state = ConnectionState.Connected;
    const lp = room.localParticipant;
    (lp as { identity: string }).identity = ME;
    const pubs = lp.trackPublications as unknown as Map<string, LocalPub>;
    vi.spyOn(lp, 'publishData').mockResolvedValue(undefined);
    vi.spyOn(lp, 'unpublishTrack').mockImplementation(async (track) => {
      for (const [key, pub] of pubs) {
        if (pub.track !== track) continue;
        pubs.delete(key);
        room.emit(RoomEvent.LocalTrackUnpublished, pub as never, lp);
      }
      return undefined;
    });
    vi.spyOn(lp, 'publishTrack').mockImplementation(async (track, options) => {
      const pub: LocalPub = {
        source: options?.source ?? Track.Source.Unknown,
        trackSid: `TR_L${pubs.size + 1}`,
        track: { mediaStreamTrack: track as MediaStreamTrack, on: () => {} },
        isMuted: false,
      };
      pubs.set(pub.trackSid, pub);
      room.emit(RoomEvent.LocalTrackPublished, pub as never, lp);
      return pub as never;
    });
    act(() => { room.emit(RoomEvent.ParticipantMetadataChanged, undefined, lp); });
    useAuthStore.setState({ user: { id: 'me', status: 'online' } as User });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(createElement(SoundController));
    act(() => { vi.advanceTimersByTime(1000); });
    const capture = {
      kind: 'video', id: 'capture', readyState: 'live', contentHint: '',
      stop: vi.fn(), getSettings: () => ({}), applyConstraints: vi.fn(async () => {}),
    } as unknown as MediaStreamTrack;
    await act(async () => { await publishScreenShare(room, new MediaStream([capture])); });
    const viewers = identities.map((id) => viewer(room, id));
    mocks.audio.playSound.mockClear();
    return { room, viewers, pubs };
  }

  /** livekit-client's full reconnect, as seen from the sharer's room. */
  function fullReconnect(room: Room, pubs: Map<string, LocalPub>, comeBack: string[]): void {
    setState(room, ConnectionState.SignalReconnecting);
    // handleRestarting: every remote participant is dropped.
    for (const identity of [...(room.remoteParticipants as Map<string, unknown>).keys()]) {
      const p = (room.remoteParticipants as Map<string, unknown>).get(identity);
      (room.remoteParticipants as Map<string, unknown>).delete(identity);
      act(() => { room.emit(RoomEvent.ParticipantDisconnected, p as never); });
    }
    setState(room, ConnectionState.Reconnecting);
    // The join response brings back whoever is still there.
    for (const identity of comeBack) {
      (room.remoteParticipants as Map<string, unknown>).set(identity, { identity, trackPublications: new Map(), isMicrophoneEnabled: true, isCameraEnabled: false });
    }
    // republishAllTracks: unpublish, then publish the same tracks again.
    const lp = room.localParticipant;
    const old = [...pubs.values()];
    act(() => {
      for (const pub of old) { pubs.delete(pub.trackSid); room.emit(RoomEvent.LocalTrackUnpublished, pub as never, lp); }
      for (const pub of old) {
        const again = { ...pub, trackSid: `${pub.trackSid}_R` };
        pubs.set(again.trackSid, again);
        room.emit(RoomEvent.LocalTrackPublished, again as never, lp);
      }
    });
    setState(room, ConnectionState.Connected);
  }

  it('tells its viewers the share is back', async () => {
    const { room, pubs } = await sharingTo([ANN]);

    fullReconnect(room, pubs, [ANN]);

    expect(sentPings(room)).toContainEqual({ type: 'stream_resume' });
  });

  it('keeps the viewers that are back in its watcher set, without a cue', async () => {
    const { room, pubs } = await sharingTo([ANN]);

    fullReconnect(room, pubs, [ANN]);

    expect(useVoiceStore.getState().streamWatchers.get(ME)).toEqual(new Set([ANN]));
    expect(cuesPlayed()).not.toContain('stream_user_left');
  });

  it('drops a viewer that is not back, with its cue', async () => {
    const { room, pubs } = await sharingTo([ANN, CAL]);

    fullReconnect(room, pubs, [ANN]);

    expect(useVoiceStore.getState().streamWatchers.get(ME)).toEqual(new Set([ANN]));
    expect(cuesPlayed().filter((c) => c === 'stream_user_left')).toHaveLength(1);
  });

  it('still drops a viewer that leaves while the room is connected', async () => {
    const { room, viewers } = await sharingTo([ANN]);

    (room.remoteParticipants as Map<string, unknown>).delete(ANN);
    act(() => { room.emit(RoomEvent.ParticipantDisconnected, viewers[0] as never); });

    expect(useVoiceStore.getState().streamWatchers.get(ME)).toBeUndefined();
    expect(cuesPlayed()).toContain('stream_user_left');
  });

  it('tells its viewers when it stops', async () => {
    const { room } = await sharingTo([ANN]);

    await act(async () => { await stopScreenShare(room); });

    expect(sentPings(room)).toContainEqual({ type: 'stream_stop' });
  });
});
