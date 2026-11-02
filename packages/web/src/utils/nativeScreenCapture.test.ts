import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canUseNativeScreenCapture,
  H264AccessUnitParser,
  maxPendingDecodeFrames,
  openNativeScreenCaptureTrack,
  shouldDropDeltaFrame,
  takeAnnexBNals,
} from './nativeScreenCapture';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'backspace');
  localStorage.removeItem('backspace.experimentalNativeScreenCapture');
});

describe('native DXGI availability', () => {
  it('enables DXGI on supported Windows Electron hosts without a hidden opt-in', () => {
    Object.defineProperty(window, 'backspace', {
      configurable: true,
      value: { platform: 'win32', startNativeScreenCapture: vi.fn(), stopNativeScreenCapture: vi.fn() },
    });
    vi.stubGlobal('VideoDecoder', class {});
    vi.stubGlobal('MediaStreamTrackGenerator', class {});

    expect(canUseNativeScreenCapture()).toBe(true);
  });

  it('keeps DXGI unavailable when the required native APIs are missing', () => {
    Object.defineProperty(window, 'backspace', {
      configurable: true,
      value: { platform: 'win32' },
    });
    vi.stubGlobal('VideoDecoder', class {});
    vi.stubGlobal('MediaStreamTrackGenerator', class {});
    expect(canUseNativeScreenCapture()).toBe(false);
  });
});

describe('native decoder queue policy', () => {
  it('scales a bounded queue to about 200 ms of frames', () => {
    expect(maxPendingDecodeFrames(60)).toBe(12);
    expect(maxPendingDecodeFrames(30)).toBe(6);
    expect(maxPendingDecodeFrames(15)).toBe(3);
    expect(maxPendingDecodeFrames(Number.NaN)).toBe(6);
    expect(maxPendingDecodeFrames(240)).toBe(12);
  });

  it('tolerates modest decode queueing but enters IDR recovery at the bound', () => {
    const limit = maxPendingDecodeFrames(60);
    expect(shouldDropDeltaFrame(false, 4, limit)).toBe(false);
    expect(shouldDropDeltaFrame(false, limit, limit)).toBe(true);
    expect(shouldDropDeltaFrame(true, 0, limit)).toBe(true);
    // The caller accepts an IDR while recovering, then resumes deltas.
    expect(shouldDropDeltaFrame(false, 0, limit)).toBe(false);
  });
});

describe('native quality updates', () => {
  it('restarts DXGI with debounced settings while keeping the generated track alive', async () => {
    vi.useFakeTimers();
    let sessionId = 0;
    const startNativeScreenCapture = vi.fn(async () => ({ id: `session-${++sessionId}`, url: `http://capture/${sessionId}` }));
    const stopNativeScreenCapture = vi.fn(async () => undefined);
    Object.defineProperty(window, 'backspace', {
      configurable: true,
      value: { platform: 'win32', startNativeScreenCapture, stopNativeScreenCapture },
    });

    class FakeGenerator extends EventTarget {
      kind = 'video';
      readyState: MediaStreamTrackState = 'live';
      writable = new WritableStream<VideoFrame>({ write: () => undefined });
      stop() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
    }
    class FakeDecoder {
      state: CodecState = 'configured';
      decodeQueueSize = 0;
      private readonly output: (frame: VideoFrame) => void;
      constructor(init: VideoDecoderInit) { this.output = init.output; }
      configure() { this.state = 'configured'; }
      decode(chunk: EncodedVideoChunk) {
        if (chunk.type === 'key') this.output({ close: () => undefined } as unknown as VideoFrame);
      }
      flush() { return Promise.resolve(); }
      close() { this.state = 'closed'; }
    }
    vi.stubGlobal('MediaStreamTrackGenerator', FakeGenerator);
    vi.stubGlobal('VideoDecoder', FakeDecoder);
    vi.stubGlobal('EncodedVideoChunk', class {
      type: string;
      constructor(init: { type: string }) { this.type = init.type; }
    });

    const audIdrAccessUnit = new Uint8Array([
      0, 0, 1, 9, 0,
      0, 0, 1, 0x65, 0,
      0, 0, 1, 9, 0,
      0, 0, 1, 0x41, 0,
    ]);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(audIdrAccessUnit);
          init.signal?.addEventListener('abort', () => value.close(), { once: true });
        },
      });
      return new Response(body, { headers: { 'x-backspace-codec': 'avc1.42E01E' } });
    }));

    const track = await openNativeScreenCaptureTrack({
      sourceId: 'screen:1:0', frameRate: 60, width: 1920, height: 1080, bitrateKbps: 8_000, cursorMode: 'hide',
    });
    expect(track).not.toBeNull();
    const publishedTrack = track;

    track!.setResolution?.({ width: 1280, height: 720 });
    track!.setFrameRate?.(30);
    track!.setBitrate?.(4_000);
    track!.setCursorMode?.('show');
    await vi.advanceTimersByTimeAsync(200);

    expect(track).toBe(publishedTrack);
    expect(track!.readyState).toBe('live');
    expect(startNativeScreenCapture).toHaveBeenNthCalledWith(2, expect.objectContaining({
      width: 1280, height: 720, frameRate: 30, bitrateKbps: 4_000, cursorMode: 'show',
    }));

    track!.stop();
    expect(stopNativeScreenCapture).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('takeAnnexBNals', () => {
  it('extracts complete NAL units and keeps an incomplete one', () => {
    const result = takeAnnexBNals(new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x09, 0x10,
      0x00, 0x00, 0x01, 0x65, 0x20,
    ]));
    expect(result.nals).toHaveLength(1);
    expect([...result.nals[0]!]).toEqual([0x00, 0x00, 0x00, 0x01, 0x09, 0x10]);
    expect([...result.remainder]).toEqual([0x00, 0x00, 0x01, 0x65, 0x20]);
  });

  it('drops leading transport bytes before the first start code', () => {
    const result = takeAnnexBNals(new Uint8Array([
      0xde, 0xad,
      0x00, 0x00, 0x01, 0x09, 0x10,
    ]));
    expect(result.nals).toHaveLength(0);
    expect([...result.remainder]).toEqual([0x00, 0x00, 0x01, 0x09, 0x10]);
  });
});

describe('H264AccessUnitParser', () => {
  it('groups NALs around access-unit delimiters and marks IDR frames', () => {
    const parser = new H264AccessUnitParser();
    const units = parser.push(new Uint8Array([
      0x00, 0x00, 0x01, 0x09, 0xf0,
      0x00, 0x00, 0x01, 0x65, 0x88,
      0x00, 0x00, 0x01, 0x09, 0xf0,
      0x00, 0x00, 0x01, 0x41, 0x9a,
      0x00, 0x00, 0x01, 0x09, 0xf0,
      0x00, 0x00, 0x01, 0x65,
    ]));
    expect(units).toHaveLength(2);
    expect(units[0]?.key).toBe(true);
    expect(units[1]?.key).toBe(false);
  });
});
