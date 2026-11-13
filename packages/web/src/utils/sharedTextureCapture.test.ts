import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSharedTextureCaptureTrack } from './sharedTextureCapture';

class Frame {
  timestamp = 1000;
  close = vi.fn();
}
const write = vi.fn(() => Promise.resolve());
const abort = vi.fn(() => Promise.resolve());
class Generator extends EventTarget {
  writable = { getWriter: () => ({ desiredSize: 1, write, abort }) };
  stop = vi.fn();
}
const stopNativeScreenCapture = vi.fn(async () => undefined);
const updateSharedTextureCapture = vi.fn(async () => undefined);
const startSharedTextureCapture = vi.fn(async () => ({ id: 'capture', transport: 'shared-texture' }));
const options = { sourceId: 'screen:0:0', frameRate: 60 };
const fallback = vi.fn(async () => null);
let active: MediaStreamTrack | null;

function deliver(frame = new Frame(), id = 'capture') {
  window.dispatchEvent(new MessageEvent('message', { source: window,
    data: { type: 'backspace:shared-texture-frame', id, sequence: 1, poolDrops: 0, frame } }));
  return frame;
}
async function open() {
  const promise = openSharedTextureCaptureTrack(options, fallback);
  await Promise.resolve();
  deliver();
  active = await promise;
  return active!;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  write.mockImplementation(() => Promise.resolve());
  startSharedTextureCapture.mockResolvedValue({ id: 'capture', transport: 'shared-texture' });
  vi.stubGlobal('MediaStreamTrackGenerator', Generator);
  vi.stubGlobal('VideoFrame', Frame);
  Object.defineProperty(window, 'backspace', { configurable: true, value: {
    platform: 'win32', startSharedTextureCapture, stopNativeScreenCapture, updateSharedTextureCapture,
  } });
});
afterEach(() => { active?.stop(); active = null; vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'backspace'); });

describe('shared texture capture', () => {
  it('waits for a written frame before returning the track', async () => {
    const track = await open();
    expect(track).toBeTruthy(); expect(write).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
  it('closes a frame only after the writer completes', async () => {
    await open();
    await Promise.resolve(); await Promise.resolve();
    let finish!: () => void;
    write.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const frame = deliver();
    expect(frame.close).not.toHaveBeenCalled();
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(frame.close).toHaveBeenCalledOnce();
  });
  it('drops pending work instead of building an unbounded queue', async () => {
    await open(); await Promise.resolve(); await Promise.resolve();
    let finish!: () => void;
    write.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    deliver(); const extra = deliver();
    expect(extra.close).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledTimes(2);
    finish(); await Promise.resolve(); await Promise.resolve();
  });
  it('changes resolution and FPS without reopening capture', async () => {
    const track = await open() as Awaited<ReturnType<typeof openSharedTextureCaptureTrack>>;
    track!.setResolution?.({ width: 1280, height: 720 }); track!.setFrameRate?.(30); track!.setBitrate?.(4000);
    expect(updateSharedTextureCapture).toHaveBeenCalledWith('capture', { width: 1280, height: 720 });
    expect(updateSharedTextureCapture).toHaveBeenCalledWith('capture', { frameRate: 30 });
    expect(startSharedTextureCapture).toHaveBeenCalledOnce();
  });
  it('returns null and releases the session when no first frame arrives', async () => {
    const promise = openSharedTextureCaptureTrack(options, fallback);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await promise).toBeNull(); expect(stopNativeScreenCapture).toHaveBeenCalledWith('capture');
  });
  it('falls back once on capture failure and keeps duplicate errors bounded', async () => {
    await open();
    const error = () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'backspace:shared-texture-error', id: 'capture' } }));
    error(); error(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(fallback).toHaveBeenCalledOnce(); expect(stopNativeScreenCapture).toHaveBeenCalledOnce();
  });
});
