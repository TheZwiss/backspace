import { EventEmitter } from 'events';
import { afterEach, expect, it, vi } from 'vitest';
import { RoomEvent, Track, type Room } from 'livekit-client';
import { parseStreamPreview, startStreamPreviews, useStreamPreviews, type StreamPreviewMode } from './streamPreviews';

const topic = 'backspace.stream-preview.v1';
const packet = (trackSid = 'screen') => new TextEncoder().encode(JSON.stringify({ type: topic, trackSid, image: 'data:image/webp;base64,YWJj' }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); useStreamPreviews.setState({ room: null, images: {} }); });

it('bounds and validates thumbnail packets', () => {
  expect(parseStreamPreview(packet())?.trackSid).toBe('screen');
  expect(parseStreamPreview(new Uint8Array(14_001))).toBeNull();
  expect(parseStreamPreview(new TextEncoder().encode('{'))).toBeNull();
  expect(parseStreamPreview(new TextEncoder().encode(JSON.stringify({ type: topic, trackSid: 'x', image: 'https://tracking.example/image' })))).toBeNull();
});

it('accepts only the authenticated sender’s published screen and clears expired/ended previews', () => {
  vi.useFakeTimers();
  const room = Object.assign(new EventEmitter(), {
    localParticipant: { identity: 'me', getTrackPublication: vi.fn(), publishData: vi.fn().mockResolvedValue(undefined) },
  });
  const cleanup = startStreamPreviews(room as unknown as Room);
  const pub = { source: Track.Source.ScreenShare, trackSid: 'screen', isMuted: false };
  const sender = { identity: 'friend', getTrackPublication: () => pub };
  room.emit(RoomEvent.DataReceived, packet('wrong-track'), sender, undefined, topic);
  expect(useStreamPreviews.getState().images.friend).toBeUndefined();
  room.emit(RoomEvent.DataReceived, packet(), sender, undefined, topic);
  expect(useStreamPreviews.getState().images.friend?.trackSid).toBe('screen');
  room.emit(RoomEvent.TrackUnpublished, pub, sender);
  expect(useStreamPreviews.getState().images.friend).toBeUndefined();
  room.emit(RoomEvent.DataReceived, packet(), sender, undefined, topic);
  vi.advanceTimersByTime(90_000);
  expect(useStreamPreviews.getState().images.friend).toBeUndefined();
  cleanup();
  expect(room.listenerCount(RoomEvent.DataReceived)).toBe(0);
  expect(useStreamPreviews.getState().room).toBeNull();
  expect(room.localParticipant.publishData).not.toHaveBeenCalled();
});

it('does not let an old room’s cleanup clear the new call’s previews', () => {
  const makeRoom = () => Object.assign(new EventEmitter(), { localParticipant: { identity: 'me', getTrackPublication: () => undefined } }) as unknown as Room;
  const first = makeRoom(); const second = makeRoom();
  const leaveFirst = startStreamPreviews(first);
  const leaveSecond = startStreamPreviews(second);
  leaveFirst();
  expect(useStreamPreviews.getState().room).toBe(second);
  leaveSecond();
});


it('samples immediately and every 30 seconds without publishing video or audio', async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,YWJj');
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1920);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1080);
  vi.stubGlobal('MediaStream', class {});
  const publishData = vi.fn().mockResolvedValue(undefined);
  const room = Object.assign(new EventEmitter(), { localParticipant: {
    identity: 'me', publishData,
    getTrackPublication: () => ({ trackSid: 'local-screen', isMuted: false, track: { mediaStreamTrack: { id: 'track', readyState: 'live' } } }),
  } });
  const leave = startStreamPreviews(room as unknown as Room);
  await Promise.resolve();
  expect(publishData).toHaveBeenCalledTimes(1);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
  expect(publishData.mock.calls[0]![0].byteLength).toBeLessThan(14_000);
  expect(publishData.mock.calls[0]![1]).toEqual({ reliable: true, topic });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(publishData).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(publishData).toHaveBeenCalledTimes(2);
  leave();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(publishData).toHaveBeenCalledTimes(2);
});


it('blurs on the sender and withdraws thumbnails immediately when hidden', async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const drawnFilters: string[] = [];
  const context = { filter: 'none', drawImage: () => drawnFilters.push(context.filter) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,YWJj');
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1920);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1080);
  vi.stubGlobal('MediaStream', class {});
  const publishData = vi.fn().mockResolvedValue(undefined);
  const room = Object.assign(new EventEmitter(), { localParticipant: {
    identity: 'me', publishData,
    getTrackPublication: () => ({ trackSid: 'local-screen', isMuted: false, track: { mediaStreamTrack: { id: 'track', readyState: 'live' } } }),
  } });
  let mode: StreamPreviewMode = 'blurred';
  let change = () => {};
  const unsubscribe = vi.fn();
  const leave = startStreamPreviews(room as unknown as Room, { getMode: () => mode, subscribe: (callback) => { change = callback; return unsubscribe; } });
  await Promise.resolve();
  expect(drawnFilters).toEqual(['blur(16px)']);
  const decode = (index: number) => JSON.parse(new TextDecoder().decode(publishData.mock.calls[index]![0]));
  expect(decode(0).mode).toBe('blurred');
  mode = 'hidden'; change();
  expect(decode(1)).toMatchObject({ mode: 'hidden', image: null });
  expect(useStreamPreviews.getState().images.me).toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(drawnFilters).toHaveLength(1);
  expect(publishData).toHaveBeenCalledTimes(2);
  leave(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it('removes an existing preview on a privacy clear even inside the rate limit', () => {
  const room = Object.assign(new EventEmitter(), { localParticipant: { identity: 'me', getTrackPublication: () => undefined } });
  const leave = startStreamPreviews(room as unknown as Room);
  const participant = { identity: 'friend', getTrackPublication: () => ({ trackSid: 'screen', isMuted: false }) };
  room.emit(RoomEvent.DataReceived, packet(), participant, undefined, topic);
  expect(useStreamPreviews.getState().images.friend).toBeDefined();
  const clear = new TextEncoder().encode(JSON.stringify({ type: topic, trackSid: 'screen', mode: 'hidden', image: null }));
  room.emit(RoomEvent.DataReceived, clear, participant, undefined, topic);
  expect(useStreamPreviews.getState().images.friend).toBeUndefined();
  leave();
});


it('does not create a thumbnail player while nobody else is in the room', () => {
  vi.useFakeTimers();
  const createElement = vi.spyOn(document, 'createElement');
  const room = Object.assign(new EventEmitter(), {
    remoteParticipants: new Map(),
    localParticipant: { identity: 'me', getTrackPublication: vi.fn() },
  });
  const leave = startStreamPreviews(room as unknown as Room);
  expect(createElement).not.toHaveBeenCalled();
  expect(room.localParticipant.getTrackPublication).not.toHaveBeenCalled();
  leave();
});


it('releases an unreadable thumbnail track after a bounded wait', async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(0);
  vi.stubGlobal('MediaStream', class {});
  const room = Object.assign(new EventEmitter(), { localParticipant: {
    identity: 'me', publishData: vi.fn(),
    getTrackPublication: () => ({ trackSid: 'local-screen', isMuted: false, track: { mediaStreamTrack: { id: 'track', readyState: 'live' } } }),
  } });
  const leave = startStreamPreviews(room as unknown as Room);
  await vi.advanceTimersByTimeAsync(1500);
  expect(pause).toHaveBeenCalledOnce();
  expect(room.localParticipant.publishData).not.toHaveBeenCalled();
  leave();
});
