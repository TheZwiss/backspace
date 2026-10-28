import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Room } from 'livekit-client';
const mocks = vi.hoisted(() => ({
  state: { isLiveKitConnected: true, isDeafened: false, soundboardVolume: 60, outputVolume: 100 },
  audio: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
  resume: vi.fn().mockResolvedValue(undefined),
  decode: vi.fn().mockResolvedValue({ duration: 0.1 }),
  start: vi.fn(), stop: vi.fn(), gain: { value: 0 }, listener: null as null | (() => void),
}));
vi.mock('../stores/voiceStore', () => ({ useVoiceStore: { getState: () => mocks.state, subscribe: (fn: () => void) => { mocks.listener = fn; return () => { mocks.listener = null; }; } } }));
vi.mock('../stores/spaceStore', () => ({ getApiForOrigin: () => ({ soundboard: { audio: mocks.audio } }) }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ resumeContext: mocks.resume, getMasterOutput: () => ({}), getContext: () => ({
  decodeAudioData: mocks.decode,
  createBufferSource: () => ({ connect: vi.fn(), disconnect: vi.fn(), start: mocks.start, stop: mocks.stop, buffer: null, onended: null }),
  createGain: () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: mocks.gain }),
}) }) } }));
import { receiveSoundboard, _resetSoundboardForTests } from './soundboard';
const packet = (ticket = '00000000-0000-4000-8000-000000000001') => new TextEncoder().encode(JSON.stringify({ type: 'soundboard_play', ticket, assetId: 'a'.repeat(64), volume: 0.8, createdAt: Date.now() }));
beforeEach(() => { _resetSoundboardForTests(); vi.clearAllMocks(); mocks.state.isLiveKitConnected = true; mocks.state.isDeafened = false; mocks.state.soundboardVolume = 60; mocks.state.outputVolume = 100; });
afterEach(_resetSoundboardForTests);
it('plays once per ticket through the selected output and reuses decoded clips', async () => {
  const room = { state: 'connected' } as Room;
  await receiveSoundboard(packet(), room, '', () => true);
  expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.audio).toHaveBeenCalledOnce();
  expect(mocks.gain.value).toBeCloseTo(0.48);
  await receiveSoundboard(packet(), room, '', () => true); expect(mocks.start).toHaveBeenCalledOnce();
  await receiveSoundboard(packet('00000000-0000-4000-8000-000000000002'), room, '', () => true);
  expect(mocks.start).toHaveBeenCalledTimes(2); expect(mocks.audio).toHaveBeenCalledOnce(); expect(mocks.decode).toHaveBeenCalledOnce();
  mocks.state.isDeafened = true; mocks.listener?.(); expect(mocks.stop).toHaveBeenCalledTimes(2);
});
it('ignores effects outside the active call or while deafened', async () => {
  const room = { state: 'connected' } as Room;
  await receiveSoundboard(packet(), room, '', () => false);
  mocks.state.isDeafened = true;
  await receiveSoundboard(packet(), room, '', () => true);
  expect(mocks.audio).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
});
it('does not play a clip whose download finishes after leaving the call', async () => {
  let resolve!: (value: ArrayBuffer) => void;
  mocks.audio.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  let current = true;
  const receiving = receiveSoundboard(packet(), { state: 'connected' } as Room, '', () => current);
  current = false; resolve(new ArrayBuffer(100)); await receiving;
  expect(mocks.start).not.toHaveBeenCalled();
});
