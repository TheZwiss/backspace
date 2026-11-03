import { getElectronAPI } from '../platform/platform';
import type { NativeCaptureOptions, NativeScreenCaptureTrack } from './nativeScreenCapture';

interface Generator extends MediaStreamTrack { writable: WritableStream<VideoFrame> }
declare const MediaStreamTrackGenerator: { new(options: { kind: 'video' }): Generator };

export async function openSharedTextureCaptureTrack(
  options: NativeCaptureOptions,
  openFallback: (options: NativeCaptureOptions) => Promise<NativeScreenCaptureTrack | null>,
): Promise<NativeScreenCaptureTrack | null> {
  const api = getElectronAPI();
  if (api?.platform !== 'win32' || !api.startSharedTextureCapture || !api.stopNativeScreenCapture
      || !api.updateSharedTextureCapture || typeof MediaStreamTrackGenerator === 'undefined'
      || typeof VideoFrame === 'undefined' || options.encodingDevice === 'cpu') return null;
  let desired = { ...options };
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const track = generator as NativeScreenCaptureTrack;
  const writer = generator.writable.getWriter();
  const originalStop = generator.stop.bind(generator);
  let sessionId: string | undefined;
  let stopped = false, recovering = false, initial = true, busy = false, live = false;
  let fallback: NativeScreenCaptureTrack | null = null;
  let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
  let lastTimestamp = 0;
  const metrics = { transport: 'shared-texture', captureEncoder: 'none', delivered: 0, writerDrops: 0, poolDrops: 0, recoveries: 0 };
  Object.assign(track, { captureMetrics: metrics });
  let firstFrame!: (value: boolean) => void;
  const ready = new Promise<boolean>(resolve => { firstFrame = resolve; });
  const firstTimer = setTimeout(() => firstFrame(false), 5000);

  const update = (values: Parameters<NonNullable<typeof api.updateSharedTextureCapture>>[1]): void => {
    if (sessionId && !stopped && !recovering) void api.updateSharedTextureCapture!(sessionId, values).catch(() => recover());
  };
  const stopSession = async (): Promise<void> => {
    const id = sessionId; sessionId = undefined;
    if (id) await api.stopNativeScreenCapture!(id).catch(() => undefined);
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true; clearTimeout(firstTimer); firstFrame(false);
    window.removeEventListener('message', receive);
    void stopSession();
    void reader?.cancel().catch(() => undefined);
    fallback?.stop();
    if (live) void api.releaseScreenCaptureActivity?.().catch(() => undefined);
    void writer.abort().catch(() => undefined);
    originalStop();
  };
  const end = (): void => { if (!stopped) { stop(); track.dispatchEvent(new Event('ended')); } };
  const recover = async (): Promise<void> => {
    if (stopped || recovering) return;
    if (initial) { firstFrame(false); return; }
    recovering = true; metrics.recoveries++;
    await stopSession();
    if (stopped) return;
    try {
      fallback = await openFallback(desired);
      if (stopped) { fallback?.stop(); return; }
      if (!fallback) { end(); return; }
      metrics.transport = 'dxgi-h264-fallback';
      metrics.captureEncoder = 'fallback';
      fallback.setLive?.(live);
      fallback.addEventListener('ended', end, { once: true });
      const Processor = (window as unknown as { MediaStreamTrackProcessor: new(options: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
      reader = new Processor({ track: fallback }).readable.getReader();
      let fallbackOrigin: number | undefined;
      const fallbackBase = lastTimestamp + 1;
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        fallbackOrigin ??= value.timestamp;
        const rebased = new VideoFrame(value, { timestamp: fallbackBase + value.timestamp - fallbackOrigin });
        try { await writer.write(rebased); metrics.delivered++; }
        finally { rebased.close(); value.close(); }
      }
      if (!stopped) end();
    } catch { end(); }
  };
  const receive = (event: MessageEvent): void => {
    const data = event.data;
    if (event.source !== window || !data || !sessionId || data.id !== sessionId) return;
    if (data.type === 'backspace:shared-texture-error') { void recover(); return; }
    if (data.type !== 'backspace:shared-texture-frame' || !(data.frame instanceof VideoFrame)) return;
    const frame = data.frame as VideoFrame;
    const acknowledge = (): void => window.postMessage({ type: 'backspace:shared-texture-ack', id: data.id, sequence: data.sequence }, '*');
    if (stopped || recovering || busy || (writer.desiredSize ?? 1) <= 0) {
      metrics.writerDrops++; frame.close(); acknowledge(); return;
    }
    busy = true;
    lastTimestamp = frame.timestamp;
    metrics.poolDrops = data.poolDrops;
    void writer.write(frame).then(() => {
      metrics.delivered++; firstFrame(true);
    }, () => { void recover(); }).finally(() => {
      busy = false; frame.close(); acknowledge();
    });
  };
  window.addEventListener('message', receive);
  track.stop = stop;
  track.setLive = value => {
    if (stopped || live === value) return;
    live = value;
    if (fallback) fallback.setLive?.(value);
    if (value) void api.holdScreenCaptureActivity?.().catch(() => undefined);
    else void api.releaseScreenCaptureActivity?.().catch(() => undefined);
  };
  track.setResolution = size => {
    desired = { ...desired, width: size?.width, height: size?.height };
    fallback?.setResolution?.(size);
    update({ width: size?.width ?? null, height: size?.height ?? null });
  };
  track.setFrameRate = frameRate => {
    if (!Number.isFinite(frameRate) || frameRate <= 0) return;
    desired.frameRate = frameRate;
    fallback?.setFrameRate?.(frameRate); update({ frameRate });
  };
  track.setBitrate = bitrateKbps => {
    desired.bitrateKbps = bitrateKbps;
    fallback?.setBitrate?.(bitrateKbps);
  };
  track.setCursorMode = cursorMode => {
    desired.cursorMode = cursorMode;
    fallback?.setCursorMode?.(cursorMode); update({ cursorMode });
  };
  try {
    const session = await api.startSharedTextureCapture(desired);
    if (session) sessionId = session.id;
    else { stop(); return null; }
    if (!(await ready)) { await stopSession(); stop(); return null; }
    initial = false;
    clearTimeout(firstTimer);
    return track;
  } catch { await stopSession(); stop(); return null; }
}
