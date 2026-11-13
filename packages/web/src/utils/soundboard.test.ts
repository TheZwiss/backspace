import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Room } from 'livekit-client';
const mocks = vi.hoisted(() => {
  const makeSource = () => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), buffer: null, onended: null as null | (() => void) });
  const makeGain = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } });
  return {
    state: { isLiveKitConnected: true, isDeafened: false, soundboardVolume: 60, outputVolume: 100 },
    audio: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
    resume: vi.fn().mockResolvedValue(undefined),
    decode: vi.fn().mockResolvedValue({ duration: 0.1 }),
    makeSource, makeGain,
    sources: [] as ReturnType<typeof makeSource>[], gains: [] as ReturnType<typeof makeGain>[],
    listener: null as null | (() => void),
  };
});
vi.mock('../stores/voiceStore', () => ({ useVoiceStore: { getState: () => mocks.state, subscribe: (fn: () => void) => { mocks.listener = fn; return () => { mocks.listener = null; }; } } }));
vi.mock('../stores/spaceStore', () => ({ getApiForOrigin: () => ({ soundboard: { audio: mocks.audio } }) }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ resumeContext: mocks.resume, getMasterOutput: () => ({}), getContext: () => ({
  decodeAudioData: mocks.decode,
  createBufferSource: () => { const source = mocks.makeSource(); mocks.sources.push(source); return source; },
  createGain: () => { const gain = mocks.makeGain(); mocks.gains.push(gain); return gain; },
}) }) } }));
import { receiveSoundboard, playLocalSoundboard, stopSoundboard, _resetSoundboardForTests } from './soundboard';
import { useSoundboardPlaybackStore } from '../stores/soundboardPlaybackStore';
const packet = (ticket = '00000000-0000-4000-8000-000000000001', senderUserId?: string) => new TextEncoder().encode(JSON.stringify({ type: 'soundboard_play', ticket, assetId: 'a'.repeat(64), volume: 0.8, createdAt: Date.now(), ...(senderUserId ? { senderIdentity: `${senderUserId}:name`, senderUserId } : {}) }));
const users = () => useSoundboardPlaybackStore.getState().userIds;
beforeEach(() => {
  _resetSoundboardForTests(); vi.clearAllMocks(); mocks.sources = []; mocks.gains = [];
  Object.assign(mocks.state, { isLiveKitConnected: true, isDeafened: false, soundboardVolume: 60, outputVolume: 100 });
});
afterEach(_resetSoundboardForTests);
it('overlaps received clips, reuses decoded audio and ignores previously seen tickets', async () => {
  const room = { state: 'connected' } as Room;
  await receiveSoundboard(packet(), room, '', () => true);
  await receiveSoundboard(packet('00000000-0000-4000-8000-000000000002'), room, '', () => true);
  await receiveSoundboard(packet(), room, '', () => true);
  expect(mocks.sources).toHaveLength(2);
  for (const source of mocks.sources) { expect(source.start).toHaveBeenCalledOnce(); expect(source.stop).not.toHaveBeenCalled(); }
  expect(mocks.audio).toHaveBeenCalledOnce(); expect(mocks.decode).toHaveBeenCalledOnce();
  for (const gain of mocks.gains) expect(gain.gain.value).toBeCloseTo(0.48);
  mocks.state.outputVolume = 50; mocks.listener?.();
  for (const gain of mocks.gains) expect(gain.gain.value).toBeCloseTo(0.24);
});
it('lets simultaneous local previews finish independently and releases every audio node', async () => {
  await Promise.all([playLocalSoundboard(new ArrayBuffer(1), 'first', 1), playLocalSoundboard(new ArrayBuffer(1), 'second', 1)]);
  expect(mocks.sources).toHaveLength(2);
  const [first, second] = mocks.sources;
  first!.onended?.();
  expect(first!.disconnect).toHaveBeenCalledOnce(); expect(mocks.gains[0]!.disconnect).toHaveBeenCalledOnce();
  expect(second!.stop).not.toHaveBeenCalled(); expect(second!.disconnect).not.toHaveBeenCalled();
  expect(mocks.listener).not.toBeNull();
  second!.onended?.();
  expect(second!.disconnect).toHaveBeenCalledOnce(); expect(mocks.gains[1]!.disconnect).toHaveBeenCalledOnce();
  expect(mocks.listener).toBeNull();
});
it('does not discard an older remote download when a newer effect finishes downloading first', async () => {
  let resolve!: (value: ArrayBuffer) => void;
  mocks.audio.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const room = { state: 'connected' } as Room;
  const first = receiveSoundboard(packet(), room, '', () => true);
  await receiveSoundboard(packet('00000000-0000-4000-8000-000000000002'), room, '', () => true);
  resolve(new ArrayBuffer(100)); await first;
  expect(mocks.sources).toHaveLength(2);
  for (const source of mocks.sources) expect(source.stop).not.toHaveBeenCalled();
});
it('ignores effects outside the active call or while deafened', async () => {
  const room = { state: 'connected' } as Room;
  await receiveSoundboard(packet(), room, '', () => false);
  mocks.state.isDeafened = true;
  await receiveSoundboard(packet(), room, '', () => true);
  await playLocalSoundboard(new ArrayBuffer(1), 'preview', 1);
  expect(mocks.audio).not.toHaveBeenCalled(); expect(mocks.sources).toHaveLength(0);
});
it('does not play a clip whose download finishes after leaving the call', async () => {
  let resolve!: (value: ArrayBuffer) => void;
  mocks.audio.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  let current = true;
  const receiving = receiveSoundboard(packet(), { state: 'connected' } as Room, '', () => current);
  current = false; resolve(new ArrayBuffer(100)); await receiving;
  expect(mocks.sources).toHaveLength(0);
});
it.each(['stop', 'deafen', 'leave'] as const)('clears all overlapping sources and sender indicators on %s', async (action) => {
  const room = { state: 'connected' } as Room;
  await receiveSoundboard(packet(undefined, 'alice'), room, '', () => true);
  await receiveSoundboard(packet('00000000-0000-4000-8000-000000000002', 'bob'), room, '', () => true);
  expect(users()).toEqual(new Set(['alice', 'bob']));
  if (action === 'stop') stopSoundboard();
  else { if (action === 'deafen') mocks.state.isDeafened = true; else mocks.state.isLiveKitConnected = false; mocks.listener?.(); }
  for (const source of mocks.sources) { expect(source.stop).toHaveBeenCalledOnce(); expect(source.disconnect).toHaveBeenCalledOnce(); }
  for (const gain of mocks.gains) expect(gain.disconnect).toHaveBeenCalledOnce();
  expect(users().size).toBe(0); expect(mocks.listener).toBeNull();
});
it('keeps each sender marked until their last effect ends, including while a preview plays', async () => {
  const room = { state: 'connected' } as Room;
  await receiveSoundboard(packet(undefined, 'alice'), room, '', () => true);
  await receiveSoundboard(packet('00000000-0000-4000-8000-000000000002', 'alice'), room, '', () => true);
  await receiveSoundboard(packet('00000000-0000-4000-8000-000000000003', 'bob'), room, '', () => true);
  await playLocalSoundboard(new ArrayBuffer(1), 'preview', 1);
  expect(useSoundboardPlaybackStore.getState().identities).toEqual(new Set(['alice:name', 'bob:name']));
  mocks.sources[0]!.onended?.(); expect(users()).toEqual(new Set(['alice', 'bob']));
  mocks.sources[2]!.onended?.(); expect(users()).toEqual(new Set(['alice']));
  mocks.sources[1]!.onended?.(); expect(users().size).toBe(0);
  expect(mocks.sources[3]!.stop).not.toHaveBeenCalled();
});
it('explicit stop invalidates both pending decoding and pending downloads', async () => {
  let resolveDecode!: (value: { duration: number }) => void;
  mocks.decode.mockImplementationOnce(() => new Promise((done) => { resolveDecode = done; }));
  const local = playLocalSoundboard(new ArrayBuffer(1), 'pending', 1);
  await vi.waitFor(() => expect(resolveDecode).toBeDefined());
  let resolveDownload!: (value: ArrayBuffer) => void;
  mocks.audio.mockImplementationOnce(() => new Promise((done) => { resolveDownload = done; }));
  const remote = receiveSoundboard(packet(), { state: 'connected' } as Room, '', () => true);
  stopSoundboard(); resolveDecode({ duration: 1 }); resolveDownload(new ArrayBuffer(100));
  await Promise.all([local, remote]);
  expect(mocks.sources).toHaveLength(0);
});
it('bounds concurrent playback without stopping existing effects and frees capacity on end', async () => {
  await Promise.all(Array.from({ length: 65 }, () => playLocalSoundboard(new ArrayBuffer(1), 'preview', 1)));
  expect(mocks.sources).toHaveLength(64);
  for (const source of mocks.sources) expect(source.stop).not.toHaveBeenCalled();
  mocks.sources[0]!.onended?.();
  await playLocalSoundboard(new ArrayBuffer(1), 'preview', 1);
  expect(mocks.sources).toHaveLength(65);
});
it('cleans nodes and indicators when the browser rejects source playback', async () => {
  const source = mocks.makeSource(); source.start.mockImplementationOnce(() => { throw new Error('start failed'); });
  const original = mocks.makeSource; mocks.makeSource = () => source;
  try {
    await expect(playLocalSoundboard(new ArrayBuffer(1), 'failed', 1, undefined, { userId: 'alice', identity: 'alice:name' })).rejects.toThrow('start failed');
    expect(source.disconnect).toHaveBeenCalledOnce(); expect(mocks.gains[0]!.disconnect).toHaveBeenCalledOnce();
    expect(users().size).toBe(0); expect(mocks.listener).toBeNull();
  } finally { mocks.makeSource = original; }
});

it('keeps accepting sustained rapid events after more than 512 earlier tickets', async () => {
  const room = { state: 'connected' } as Room;
  for (let index = 0; index < 600; index++) {
    await receiveSoundboard(packet(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`), room, '', () => true);
    mocks.sources.at(-1)!.onended?.();
  }
  expect(mocks.sources).toHaveLength(600);
  for (const source of mocks.sources) expect(source.stop).not.toHaveBeenCalled();
});
