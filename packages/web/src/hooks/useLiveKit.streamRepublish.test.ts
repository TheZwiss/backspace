import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, RoomEvent, DisconnectReason, Track, ConnectionState } from 'livekit-client';
import { useLiveKit } from './useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { STREAM_REPUBLISH_WINDOW_MS } from '../utils/streamRepublish';
import { publishScreenShare, republishScreenShare, stopScreenShare } from '../utils/screenShare';
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

function addMicrophone(sharer: Sharer): void {
  sharer.trackPublications.set('TR_MIC', makePublication(Track.Source.Microphone, 'TR_MIC'));
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

describe('a second republish announced before the first one\'s new track arrives', () => {
  // The codec pill toggled twice quickly: the second announcement can reach the
  // viewer while it is still waiting for the first republish's new track.

  it('keeps watching through both republishes', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    const seen = recordSharingFlag();

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    announceRepublish(room, sharer);
    const second = publish(room, sharer, 'TR_2');

    expect(second.setSubscribed).toHaveBeenCalledWith(true);
    expect(seen).not.toContain(false);

    // The second announcement's removal bridges too.
    unpublish(room, sharer, second);
    const third = publish(room, sharer, 'TR_3');
    expect(third.setSubscribed).toHaveBeenCalledWith(true);
    expect(seen).not.toContain(false);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(true);
  });

  it('ends the share cleanly when no new track follows', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    vi.useFakeTimers();

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    announceRepublish(room, sharer);
    act(() => { vi.advanceTimersByTime(STREAM_REPUBLISH_WINDOW_MS); });

    expect(sharerIsListedAsSharing()).toBe(false);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(false);
    const later = publish(room, sharer, 'TR_3');
    expect(later.setSubscribed).not.toHaveBeenCalled();
  });

  it('ends the share cleanly when the second republish never removes the new track', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('bob');
    vi.useFakeTimers();

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    announceRepublish(room, sharer);
    const second = publish(room, sharer, 'TR_2');
    act(() => { vi.advanceTimersByTime(STREAM_REPUBLISH_WINDOW_MS); });

    // The share goes on under TR_2; a later stop is a plain end.
    expect(sharerIsListedAsSharing()).toBe(true);
    unpublish(room, sharer, second);
    expect(sharerIsListedAsSharing()).toBe(false);
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
    mocks.space.dmChannels = [{ id: 'dm', members: [{ id: 'local-bob', homeUserId: 'bob', homeInstance: 'b.example' }] }];
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

  it('leaves no watch behind when the sharer leaves mid-share', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    addMicrophone(sharer);
    publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('local-bob');

    leave(room, sharer);

    expect(useVoiceStore.getState().watchingStreams.has('local-bob')).toBe(false);
  });

  it('leaves no watch behind when the sharer leaves between a republish\'s tracks', async () => {
    const room = await connectedRoom();
    const sharer = makeSharer(room);
    addMicrophone(sharer);
    const first = publish(room, sharer, 'TR_1');
    useVoiceStore.getState().watchStream('local-bob');

    announceRepublish(room, sharer);
    unpublish(room, sharer, first);
    leave(room, sharer);

    expect(useVoiceStore.getState().watchingStreams.has('local-bob')).toBe(false);
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

describe('the sharer\'s own side across a republish', () => {
  // The sharer changes codec: republishScreenShare unpublishes the screen share
  // and publishes the same capture again. For the sharer this is the same share
  // going on, exactly as it is for its viewers: no stream_ended / stream_started
  // cue, and the viewers who keep watching stay in its watcher set.
  const ME = 'me:Me';
  const VIEWER = 'ann:Ann';

  interface LocalPub { source: Track.Source; trackSid: string; track: { mediaStreamTrack: MediaStreamTrack; on: () => void }; isMuted: boolean }

  beforeEach(() => {
    // jsdom has no MediaStream; the share code builds one from the live tracks.
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

  /** The local participant, with publish and unpublish emitting the SDK's events. */
  function localSharer(room: Room, identity = ME) {
    const lp = room.localParticipant;
    (lp as { identity: string }).identity = identity;
    const pubs = lp.trackPublications as unknown as Map<string, LocalPub>;
    let sid = 0;
    vi.spyOn(lp, 'publishData').mockResolvedValue(undefined);
    vi.spyOn(lp, 'unpublishTrack').mockImplementation(async (track) => {
      for (const [key, pub] of pubs) {
        if (pub.track !== track) continue;
        pubs.delete(key);
        // livekit-client emits this synchronously inside unpublishTrack.
        room.emit(RoomEvent.LocalTrackUnpublished, pub as never, lp);
      }
      return undefined;
    });
    vi.spyOn(lp, 'publishTrack').mockImplementation(async (track, options) => {
      await Promise.resolve(); // the server accepting the publication
      const pub: LocalPub = {
        source: options?.source ?? Track.Source.Unknown,
        trackSid: `TR_L${++sid}`,
        track: { mediaStreamTrack: track as MediaStreamTrack, on: () => {} },
        isMuted: false,
      };
      pubs.set(pub.trackSid, pub);
      room.emit(RoomEvent.LocalTrackPublished, pub as never, lp);
      return pub as never;
    });
  }

  function videoCapture(withAudio = false): MediaStream {
    const track = {
      kind: 'video', id: 'capture', readyState: 'live', contentHint: '',
      stop: vi.fn(), getSettings: () => ({}), applyConstraints: vi.fn(async () => {}),
    } as unknown as MediaStreamTrack;
    const audio = { kind: 'audio', id: 'loopback', readyState: 'live', stop: vi.fn() } as unknown as MediaStreamTrack;
    return new MediaStream(withAudio ? [track, audio] : [track]);
  }

  /** A viewer's ping as an older client sends it: the sharer's user id as that viewer lists it. */
  function viewerPing(room: Room, watching: boolean, target: { target: string; targetIdentity?: string } = { target: 'me' }): void {
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'stream_watch', ...target, watching }));
    act(() => { room.emit(RoomEvent.DataReceived, payload, { identity: VIEWER } as never); });
  }

  function cuesPlayed(): string[] {
    return mocks.audio.playSound.mock.calls.map(([name]) => name as string);
  }

  async function sharing(identity = ME, { withAudio = false } = {}) {
    const room = await connectedRoom();
    localSharer(room, identity);
    // List ourselves under the identity before the cues start, as a real
    // connect does: the token's identity is known from the first update.
    act(() => { room.emit(RoomEvent.ParticipantMetadataChanged, undefined, room.localParticipant); });
    useAuthStore.setState({ user: { id: 'me', status: 'online' } as User });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(createElement(SoundController));
    act(() => { vi.advanceTimersByTime(1000); });
    await act(async () => { await publishScreenShare(room, videoCapture(withAudio)); });
    expect(cuesPlayed()).toEqual(['stream_started']);
    mocks.audio.playSound.mockClear();
    return room;
  }

  async function sharingWithOneViewer() {
    const room = await sharing();
    viewerPing(room, true);
    expect(cuesPlayed()).toEqual(['stream_user_joined']);
    mocks.audio.playSound.mockClear();
    return room;
  }

  it('plays neither stream_ended nor stream_started for the codec change', async () => {
    const room = await sharingWithOneViewer();
    const seen = recordSharingFlag(ME);

    await act(async () => { await republishScreenShare(room); });

    expect(cuesPlayed()).toEqual([]);
    expect(seen).not.toContain(false);
  });

  it('keeps the viewers who resume in its watcher set, so a later stop is heard', async () => {
    const room = await sharingWithOneViewer();

    await act(async () => { await republishScreenShare(room); });
    viewerPing(room, false);

    expect(cuesPlayed()).toEqual(['stream_user_left']);
  });

  it('still plays stream_ended when the republish fails', async () => {
    const room = await sharingWithOneViewer();
    vi.mocked(room.localParticipant.publishTrack).mockRejectedValueOnce(new Error('publish timed out'));

    await act(async () => { await republishScreenShare(room); });

    expect(cuesPlayed()).toEqual(['stream_ended']);
    expect(sharerIsListedAsSharing(ME)).toBe(false);
  });

  it('still plays stream_ended for a real stop', async () => {
    const room = await sharingWithOneViewer();

    await act(async () => { await stopScreenShare(room); });

    expect(cuesPlayed()).toEqual(['stream_ended']);
    expect(sharerIsListedAsSharing(ME)).toBe(false);
  });

  describe('a full LiveKit reconnect while sharing', () => {
    // livekit-client 2.22.3, Room.handleSignalRestarted: with the room in
    // Reconnecting it calls LocalParticipant.republishAllTracks, which runs
    // unpublishTrack(track, false) for every local track (LocalTrackUnpublished
    // fires synchronously, before its first await) and then publishes the same
    // track again (LocalTrackPublished). Only after that does the room go
    // Connected. A republish that throws is logged and the room still goes
    // Connected; a restart that fails ends in handleDisconnect and Disconnected.

    function setState(room: Room, state: ConnectionState): void {
      (room as { state: ConnectionState }).state = state;
      act(() => { room.emit(RoomEvent.ConnectionStateChanged, state); });
    }

    /** The SDK's republishAllTracks: every unpublish first, then the publishes it gets to. */
    function sdkRepublishAllTracks(room: Room, republish: (source: Track.Source) => boolean): void {
      const lp = room.localParticipant;
      const pubs = lp.trackPublications as unknown as Map<string, LocalPub>;
      const old = [...pubs.values()];
      act(() => {
        for (const pub of old) {
          pubs.delete(pub.trackSid);
          room.emit(RoomEvent.LocalTrackUnpublished, pub as never, lp);
        }
      });
      act(() => {
        for (const pub of old) {
          if (!republish(pub.source)) continue;
          const again: LocalPub = { ...pub, trackSid: `${pub.trackSid}_R` };
          pubs.set(again.trackSid, again);
          room.emit(RoomEvent.LocalTrackPublished, again as never, lp);
        }
      });
    }

    function sharingFlags(): boolean[] {
      const seen: boolean[] = [];
      useVoiceStore.subscribe((state) => { seen.push(state.isScreenSharing); });
      return seen;
    }

    it('keeps the share, its own tile and its Stop control through the SDK\'s republish', async () => {
      const room = await sharing();
      const flags = sharingFlags();
      const listed = recordSharingFlag(ME);

      setState(room, ConnectionState.Reconnecting);
      sdkRepublishAllTracks(room, () => true);
      setState(room, ConnectionState.Connected);

      expect(flags).not.toContain(false);
      expect(listed).not.toContain(false);
      expect(useVoiceStore.getState().isScreenSharing).toBe(true);
      expect(sharerIsListedAsSharing(ME)).toBe(true);
    });

    it('keeps the system audio on when the SDK republishes it too', async () => {
      useVoiceStore.setState({
        screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, shareAudio: true },
      });
      const room = await sharing(ME, { withAudio: true });
      expect(useVoiceStore.getState().screenShareAudio).toBe('published');

      setState(room, ConnectionState.Reconnecting);
      sdkRepublishAllTracks(room, () => true);
      setState(room, ConnectionState.Connected);

      expect(useVoiceStore.getState().screenShareAudio).toBe('published');
    });

    it('ends the share when the reconnect completes without the screen share', async () => {
      const room = await sharing();

      setState(room, ConnectionState.Reconnecting);
      sdkRepublishAllTracks(room, (source) => source !== Track.Source.ScreenShare);
      expect(useVoiceStore.getState().isScreenSharing).toBe(true);
      setState(room, ConnectionState.Connected);

      expect(useVoiceStore.getState().isScreenSharing).toBe(false);
      expect(sharerIsListedAsSharing(ME)).toBe(false);
    });

    it('ends the share when the reconnect fails', async () => {
      const room = await sharing();

      setState(room, ConnectionState.Reconnecting);
      sdkRepublishAllTracks(room, () => false);
      (room as { state: ConnectionState }).state = ConnectionState.Disconnected;
      act(() => { room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON); });

      expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    });

    it('still ends the share when the source ends during a reconnect', async () => {
      // The shared window closes while the room is Reconnecting: livekit-client
      // unpublishes the ended track, and nothing publishes it again.
      const room = await sharing();

      setState(room, ConnectionState.Reconnecting);
      const lp = room.localParticipant;
      const pubs = lp.trackPublications as unknown as Map<string, LocalPub>;
      const video = [...pubs.values()].find((p) => p.source === Track.Source.ScreenShare)!;
      act(() => {
        pubs.delete(video.trackSid);
        room.emit(RoomEvent.LocalTrackUnpublished, video as never, lp);
      });
      setState(room, ConnectionState.Connected);

      expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    });
  });

  describe('when the sharer\'s id differs between instances', () => {
    // The watcher set is keyed by the sharer's LiveKit identity, the one string
    // every client in the room shares. Its user id is per instance.

    it('a remote-instance space channel: hears viewers who name it by that instance\'s id', async () => {
      // The token comes from the space's instance, so the identity carries the
      // id that instance has for this user, not the home account's id ('me').
      const room = await sharing('r-77:Me');

      viewerPing(room, true, { target: 'r-77' });
      viewerPing(room, false, { target: 'r-77', targetIdentity: 'r-77:Me' });

      expect(cuesPlayed()).toEqual(['stream_user_joined', 'stream_user_left']);
    });

    it('a federated DM call: hears a viewer whose client knows it by another id', async () => {
      // The identity carries the home id; each client lists the member under
      // its own local id, so the viewer's `target` means nothing here.
      mocks.space.dmChannels = [{ id: 'dm', members: [{ id: 'me', homeUserId: 'me-home' }] }];
      useVoiceStore.setState({ activeDmCall: { dmChannelId: 'dm' } as never });
      const room = await sharing('me-home:Me');

      viewerPing(room, true, { target: 'viewer-local-me', targetIdentity: 'me-home:Me' });
      await act(async () => { await republishScreenShare(room); });
      viewerPing(room, false, { target: 'viewer-local-me', targetIdentity: 'me-home:Me' });

      expect(cuesPlayed()).toEqual(['stream_user_joined', 'stream_user_left']);
    });

    it('ignores pings about another sharer', async () => {
      const room = await sharing();

      viewerPing(room, true, { target: 'bob', targetIdentity: 'bob:Bob' });

      expect(cuesPlayed()).toEqual([]);
    });
  });
});

describe('events from a room that has been replaced', () => {
  // A channel switch tears the old room down after the new one exists; the
  // old room's late events must not reach the new room's republish state.

  async function switchRooms() {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    const oldRoom = result.current.room!;
    const oldSharer = makeSharer(oldRoom);
    const oldPub = publish(oldRoom, oldSharer, 'TR_OLD');
    await act(async () => { await result.current.connect('other-channel'); });
    const newRoom = result.current.room!;
    expect(newRoom).not.toBe(oldRoom);
    return { oldRoom, oldSharer, oldPub, newRoom };
  }

  it('an old room\'s screen-share removal does not end the watch in the new room', async () => {
    const { oldRoom, oldSharer, oldPub, newRoom } = await switchRooms();
    const sharer = makeSharer(newRoom);
    publish(newRoom, sharer, 'TR_NEW');
    useVoiceStore.getState().watchStream('bob');

    unpublish(oldRoom, oldSharer, oldPub);

    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(true);
    expect(sharerIsListedAsSharing()).toBe(true);
  });

  it('an old room\'s republish announcement does not bridge a real stop in the new room', async () => {
    const { oldRoom, oldSharer, newRoom } = await switchRooms();
    const sharer = makeSharer(newRoom);
    const pub = publish(newRoom, sharer, 'TR_NEW');
    useVoiceStore.getState().watchStream('bob');

    announceRepublish(oldRoom, oldSharer);
    unpublish(newRoom, sharer, pub);

    expect(sharerIsListedAsSharing()).toBe(false);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(false);
  });

  it('an old room\'s departing sharer does not cancel a republish in the new room', async () => {
    const { oldRoom, oldSharer, newRoom } = await switchRooms();
    const sharer = makeSharer(newRoom);
    const pub = publish(newRoom, sharer, 'TR_NEW');
    useVoiceStore.getState().watchStream('bob');
    announceRepublish(newRoom, sharer);
    unpublish(newRoom, sharer, pub);

    leave(oldRoom, oldSharer);

    expect(sharerIsListedAsSharing()).toBe(true);
    expect(useVoiceStore.getState().watchingStreams.has('bob')).toBe(true);
  });
});
