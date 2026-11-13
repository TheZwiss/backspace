import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sapphi-red/web-noise-suppressor', () => ({
  RnnoiseWorkletNode: class {}, loadRnnoise: vi.fn(),
}));
import { AudioManager } from './AudioManager';

function capture() {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  const stream = { active: true, getTracks: () => [track] } as unknown as MediaStream;
  return { track, stream };
}

describe('AudioManager.releaseInputStream', () => {
  const am = AudioManager.getInstance();
  const state = am as unknown as {
    inputSource: { disconnect: () => void } | null;
    currentStream: MediaStream | null;
    currentInputDeviceId: string;
    streamGeneration: number;
    inputReleaseGeneration: number;
    inputSwitchChain: Promise<MediaStream | null>;
    isInitialized: boolean;
  };
  const getUserMedia = vi.fn<() => Promise<MediaStream>>();

  beforeEach(() => {
    am.setTextInputOnly(false);
    state.inputSource = null;
    state.currentStream = null;
    state.currentInputDeviceId = 'default';
    state.streamGeneration = 0;
    state.inputReleaseGeneration = 0;
    state.inputSwitchChain = Promise.resolve(null);
    state.isInitialized = true;
    am.clearInputDenial();
    getUserMedia.mockReset();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  });
  afterEach(() => { am.setTextInputOnly(false); am.releaseInputStream(); vi.unstubAllGlobals(); });

  it('text voice releases hardware and blocks capture until the user leaves text mode', async () => {
    const old = capture(); const fresh = capture();
    getUserMedia.mockResolvedValueOnce(old.stream).mockResolvedValueOnce(fresh.stream);
    await am.setInputDevice('mic');
    am.setTextInputOnly(true);
    expect(old.track.stop).toHaveBeenCalledOnce();
    expect(await am.setInputDevice('other')).toBeNull();
    expect(getUserMedia).toHaveBeenCalledOnce();
    am.setTextInputOnly(false);
    expect(await am.setInputDevice('mic')).toBe(fresh.stream);
  });

  it('text voice stops a capture that resolves after enabling the mode', async () => {
    const late = capture(); let finish!: (stream: MediaStream) => void;
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = am.setInputDevice('mic');
    await Promise.resolve();
    am.setTextInputOnly(true); finish(late.stream);
    expect(await pending).toBeNull();
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(am.hasActiveStream()).toBe(false);
  });

  it('stops every track and detaches handlers without reporting upstream loss', async () => {
    const tracks = [capture().track, capture().track];
    getUserMedia.mockResolvedValue({ active: true, getTracks: () => tracks } as unknown as MediaStream);
    const loss = vi.fn();
    const unsubscribe = am.onInputTrackEnded(loss);
    await am.setInputDevice('mic');
    expect(tracks[0].onended).toBeTypeOf('function');
    am.releaseInputStream();
    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(track.onended).toBeNull();
    }
    expect(state.currentStream).toBeNull();
    expect(loss).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('disconnects the input source', () => {
    const disconnect = vi.fn();
    state.inputSource = { disconnect };
    am.releaseInputStream();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(state.inputSource).toBeNull();
  });

  it('resets device identity and advances the publication generation', () => {
    state.currentInputDeviceId = 'concrete-mic-id';
    state.streamGeneration = 7;
    am.releaseInputStream();
    expect(am.getCurrentInputDeviceId()).toBe('default');
    expect(am.getStreamGeneration()).toBe(8);
  });

  it('tolerates repeated release without stopping tracks twice', () => {
    const { track, stream } = capture();
    state.currentStream = stream;
    am.releaseInputStream();
    am.releaseInputStream();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(am.hasActiveStream()).toBe(false);
  });

  it('reacquires the same device on the next join', async () => {
    const first = capture();
    const next = capture();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(next.stream);
    await am.setInputDevice('mic');
    am.releaseInputStream();
    expect(await am.setInputDevice('mic')).toBe(next.stream);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(next.track.stop).not.toHaveBeenCalled();
  });

  it('cancels queued capture without requesting permission', async () => {
    const pending = am.setInputDevice('mic');
    am.releaseInputStream();
    expect(await pending).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('stops a late permission result and skips other queued acquisitions', async () => {
    const late = capture();
    let resolve!: (stream: MediaStream) => void;
    getUserMedia.mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = am.setInputDevice('mic');
    const queued = am.setInputDevice('other-mic');
    await Promise.resolve();
    am.releaseInputStream();
    resolve(late.stream);
    expect(await pending).toBeNull();
    expect(await queued).toBeNull();
    expect(late.track.stop).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(am.hasActiveStream()).toBe(false);
  });

  it('preserves a new join while the old permission request finishes', async () => {
    const late = capture();
    const fresh = capture();
    let resolve!: (stream: MediaStream) => void;
    getUserMedia.mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValueOnce(fresh.stream);
    const oldJoin = am.setInputDevice('mic');
    await Promise.resolve();
    am.releaseInputStream();
    const newJoin = am.setInputDevice('mic');
    resolve(late.stream);
    await oldJoin;
    expect(await newJoin).toBe(fresh.stream);
    expect(late.track.stop).toHaveBeenCalledTimes(1);
    expect(fresh.track.stop).not.toHaveBeenCalled();
  });

  it('does not cache a denial from an abandoned call', async () => {
    const fresh = capture();
    let reject!: (error: Error) => void;
    getUserMedia.mockReturnValueOnce(new Promise((_resolve, r) => { reject = r; })).mockResolvedValueOnce(fresh.stream);
    const pending = am.setInputDevice('mic');
    await Promise.resolve();
    am.releaseInputStream();
    reject(new DOMException('Denied', 'NotAllowedError'));
    expect(await pending).toBeNull();
    expect(await am.setInputDevice('mic')).toBe(fresh.stream);
  });
});
