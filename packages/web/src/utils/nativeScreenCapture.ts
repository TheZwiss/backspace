import { createEncoderFrameNormalizer } from './encoderFrame';
import { getElectronAPI } from '../platform/platform';
import { openSharedTextureCaptureTrack } from './sharedTextureCapture';

export interface NativeCaptureOptions {
  encodingDevice?: 'gpu' | 'cpu';
  sourceId: string;
  displaySourceId?: string;
  frameRate: number;
  width?: number;
  height?: number;
  bitrateKbps?: number;
  cursorMode?: 'auto' | 'show' | 'hide';
  crop?: { x: number; y: number; width: number; height: number };
}

export interface AnnexBAccessUnit {
  data: Uint8Array<ArrayBuffer>;
  key: boolean;
}

export interface NativeScreenCaptureTrack extends MediaStreamTrack {
  setResolution?: (size: { width: number; height: number } | undefined) => void;
  setFrameRate?: (rate: number) => void;
  setBitrate?: (bitrateKbps: number) => void;
  setCursorMode?: (mode: 'auto' | 'show' | 'hide') => void;
  setLive?: (live: boolean) => void;
}

/** Keep the decoder's queued work near a 200 ms latency budget. */
export function maxPendingDecodeFrames(frameRate: number): number {
  const fps = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 30;
  return Math.max(3, Math.min(12, Math.ceil(fps / 5)));
}

/** Delta frames after a dropped reference are unsafe until the next IDR. */
export function shouldDropDeltaFrame(
  waitingForKeyframe: boolean,
  decodeQueueSize: number,
  queueLimit: number,
): boolean {
  return waitingForKeyframe || decodeQueueSize >= queueLimit;
}

interface AnnexBNals {
  nals: Uint8Array<ArrayBuffer>[];
  remainder: Uint8Array<ArrayBuffer>;
}

interface MediaStreamTrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>;
}

declare const MediaStreamTrackGenerator: {
  new (init: { kind: 'video' }): MediaStreamTrackGenerator;
};

function startCodeLength(data: Uint8Array, offset: number): number {
  if (data[offset] !== 0 || data[offset + 1] !== 0) return 0;
  if (data[offset + 2] === 1) return 3;
  if (data[offset + 2] === 0 && data[offset + 3] === 1) return 4;
  return 0;
}

/** Split an Annex B H.264 stream into complete start-code-prefixed NAL units. */
export function takeAnnexBNals(data: Uint8Array<ArrayBufferLike>): AnnexBNals {
  const nals: Uint8Array<ArrayBuffer>[] = [];
  let cursor = 0;
  for (;;) {
    let start = -1;
    for (let index = cursor; index + 2 < data.length; index++) {
      if (startCodeLength(data, index)) {
        start = index;
        break;
      }
    }
    if (start < 0) {
      const tail = Math.min(3, data.length);
      return {
        nals,
        remainder: data.subarray(data.length - tail) as Uint8Array<ArrayBuffer>,
      };
    }
    let next = -1;
    for (let index = start + 3; index + 2 < data.length; index++) {
      if (startCodeLength(data, index)) {
        next = index;
        break;
      }
    }
    if (next < 0) {
      return { nals, remainder: data.subarray(start) as Uint8Array<ArrayBuffer> };
    }
    nals.push(data.subarray(start, next) as Uint8Array<ArrayBuffer>);
    cursor = next;
  }
}

/** Reassemble H.264 access units from AUD-delimited Annex B packets. */
export class H264AccessUnitParser {
  private remainder: Uint8Array<ArrayBuffer> = new Uint8Array();
  private current: Uint8Array<ArrayBuffer>[] = [];

  push(chunk: Uint8Array<ArrayBufferLike>): AnnexBAccessUnit[] {
    const joined = new Uint8Array(this.remainder.length + chunk.length);
    joined.set(this.remainder);
    joined.set(chunk, this.remainder.length);
    const parsed = takeAnnexBNals(joined);
    this.remainder = parsed.remainder;
    const units: AnnexBAccessUnit[] = [];

    const flush = (): void => {
      if (this.current.length === 0) return;
      const length = this.current.reduce((total, nal) => total + nal.length, 0);
      const data = new Uint8Array(length);
      let offset = 0;
      let key = false;
      for (const nal of this.current) {
        data.set(nal, offset);
        offset += nal.length;
        const prefix = nal[2] === 1 ? 3 : 4;
        const type = (nal[prefix] ?? 0) & 0x1f;
        if (type === 5) key = true;
      }
      units.push({ data, key });
      this.current = [];
    };

    for (const nal of parsed.nals) {
      const prefix = nal[2] === 1 ? 3 : 4;
      const type = (nal[prefix] ?? 0) & 0x1f;
      if (type === 9) {
        flush();
        this.current = [nal];
      } else {
        this.current.push(nal);
      }
    }
    return units;
  }
}

export function canUseNativeScreenCapture(): boolean {
  const api = getElectronAPI();
  return api?.platform === 'win32'
    && typeof api.startNativeScreenCapture === 'function'
    && typeof api.stopNativeScreenCapture === 'function'
    && typeof VideoDecoder !== 'undefined'
    && typeof MediaStreamTrackGenerator !== 'undefined';
}

/**
 * Prefer GPU shared textures with an owned encoder surface. Older desktops and
 * unsupported outputs retain the DXGI/H.264 bridge as a fallback.
 */
export async function openNativeScreenCaptureTrack(
  options: NativeCaptureOptions,
): Promise<NativeScreenCaptureTrack | null> {
  return await openSharedTextureCaptureTrack(options, openEncodedNativeScreenCaptureTrack)
    ?? openEncodedNativeScreenCaptureTrack(options);
}

async function openEncodedNativeScreenCaptureTrack(
  options: NativeCaptureOptions,
): Promise<NativeScreenCaptureTrack | null> {
  const api = getElectronAPI();
  if (!api?.startNativeScreenCapture || !api.stopNativeScreenCapture) return null;

  let desired = { ...options };
  const session = await api.startNativeScreenCapture(desired).catch(() => null);
  if (!session) return null;

  const controller = new AbortController();
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const track = generator as NativeScreenCaptureTrack;
  const writer = generator.writable.getWriter();
  const metrics = {
    startedAt: performance.now(), reads: 0, bytes: 0, accessUnits: 0,
    captureEncoder: 'unknown', normalizedFrames: 0, normalizationTimeMs: 0,
    submitted: 0, decoded: 0, delivered: 0, writerDrops: 0,
    recoveryDrops: 0, bufferedDrops: 0, maxDecodeQueue: 0,
    writeTimeMs: 0, stoppedAt: 0,
    multiUnitReads: 0, maxUnitsPerRead: 0, shortTimestampGaps: 0,
    timestampGapUs: 0, timestampSamples: 0,
  };
  Object.assign(generator, { captureMetrics: metrics });
  const nativeStop = generator.stop.bind(generator);
  let decoder: VideoDecoder | null = null;
  let activeSession = session;
  let activeController = controller;
  let runGeneration = 0;
  let desiredRevision = 0;
  let appliedRevision = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryAttempt = 0;
  let restartQueue = Promise.resolve();
  let timestamp = 0;
  let stopped = false;
  let ended = false;
  let holdingActivityScan = false;
  let activeSessionClosed = false;

  const holdActivityScan = (): void => {
    if (holdingActivityScan) return;
    holdingActivityScan = true;
    void api.holdScreenCaptureActivity?.().catch(() => undefined);
  };
  const releaseActivityScan = (): void => {
    if (!holdingActivityScan) return;
    holdingActivityScan = false;
    void api.releaseScreenCaptureActivity?.().catch(() => undefined);
  };

  const stopCurrentSession = async (): Promise<void> => {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
    runGeneration += 1;
    activeController.abort();
    metrics.stoppedAt = performance.now();
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null;
    await api.stopNativeScreenCapture!(activeSession.id).catch(() => undefined);
    activeSessionClosed = true;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    void stopCurrentSession();
    void writer.abort().catch(() => undefined);
    nativeStop();
    releaseActivityScan();
  };
  generator.stop = stop;
  Object.assign(generator, {
    setLive: (live: boolean): void => {
      if (live) holdActivityScan();
      else releaseActivityScan();
    },
    setResolution: (size: { width: number; height: number } | undefined): void => {
      const width = size?.width;
      const height = size?.height;
      if (desired.width === width && desired.height === height) return;
      desired = {
        ...desired,
        width,
        height,
      };
      scheduleRestart();
    },
    setFrameRate: (frameRate: number): void => {
      if (!Number.isFinite(frameRate) || frameRate <= 0) return;
      if (desired.frameRate === frameRate) return;
      desired = { ...desired, frameRate };
      scheduleRestart();
    },
    setBitrate: (bitrateKbps: number): void => {
      if (!Number.isFinite(bitrateKbps) || bitrateKbps <= 0) return;
      if (desired.bitrateKbps === bitrateKbps) return;
      desired = { ...desired, bitrateKbps };
      scheduleRestart();
    },
    setCursorMode: (cursorMode: 'auto' | 'show' | 'hide'): void => {
      if (desired.cursorMode === cursorMode) return;
      desired = { ...desired, cursorMode };
      scheduleRestart();
    },
  });

  function scheduleRestart(): void {
    desiredRevision++;
    if (stopped) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      restartQueue = restartQueue.then(async () => {
        if (stopped || appliedRevision === desiredRevision) return;
        const nextOptions = { ...desired };
        const revision = desiredRevision;
        await stopCurrentSession();
        if (stopped) return;
        const nextSession = await api!.startNativeScreenCapture!(nextOptions).catch(() => null);
        if (!nextSession) {
          finish();
          return;
        }
        if (stopped) {
          await api!.stopNativeScreenCapture!(nextSession.id).catch(() => undefined);
          return;
        }
        appliedRevision = revision;
        activeSession = nextSession;
        activeController = new AbortController();
        startDecodeSession(nextSession.url, activeController, ++runGeneration, nextOptions, false);
      }).catch((error) => {
        if (!stopped) console.warn('[ScreenShare] Could not restart native capture:', error);
        finish();
      });
    }, 180);
  }

  let resolveFirstFrame!: (received: boolean) => void;
  const firstFrame = new Promise<boolean>((resolve) => {
    resolveFirstFrame = resolve;
  });
  const timeout = setTimeout(() => resolveFirstFrame(false), 5_000);

  const finish = (): void => {
    if (ended || stopped) return;
    ended = true;
    clearTimeout(timeout);
    resolveFirstFrame(false);
    stop();
    generator.dispatchEvent(new Event('ended'));
  };

  const recoverCapture = (generation: number): void => {
    if (stopped || ended || generation !== runGeneration || recoveryTimer) return;
    const delay = Math.min(300 * (2 ** recoveryAttempt), 4_000);
    recoveryAttempt += 1;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      restartQueue = restartQueue.then(async () => {
        if (stopped || ended || generation !== runGeneration) return;
        activeController.abort();
        if (decoder && decoder.state !== 'closed') decoder.close();
        decoder = null;
        if (!activeSessionClosed) {
          await api!.stopNativeScreenCapture!(activeSession.id).catch(() => undefined);
          activeSessionClosed = true;
        }
        const nextSession = await api!.startNativeScreenCapture!(desired).catch(() => null);
        if (!nextSession) {
          recoverCapture(generation);
          return;
        }
        if (stopped || ended || generation !== runGeneration) {
          await api!.stopNativeScreenCapture!(nextSession.id).catch(() => undefined);
          return;
        }
        activeSession = nextSession;
        activeSessionClosed = false;
        activeController = new AbortController();
        startDecodeSession(nextSession.url, activeController, ++runGeneration, desired, false);
      }).catch((error) => {
        if (!stopped && !ended) console.warn('[ScreenShare] Could not recover native capture:', error);
        recoverCapture(generation);
      });
    }, delay);
  };

  const startDecodeSession = (
    url: string,
    runController: AbortController,
    generation: number,
    runOptions: NativeCaptureOptions,
    initial: boolean,
  ): void => {
    void (async () => {
    let decoderForRun: VideoDecoder | null = null;
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: runController.signal,
      });
      if (!response.ok || !response.body) throw new Error(`native capture HTTP ${response.status}`);
      metrics.captureEncoder = response.headers.get('x-backspace-capture-encoder') ?? 'unknown';
      const codec = response.headers.get('x-backspace-codec') ?? 'avc1.42E01E';

      const normalizeFrame = createEncoderFrameNormalizer();
      const sessionDecoder = new VideoDecoder({
        output: (frame) => {
          if (generation !== runGeneration || stopped) { frame.close(); return; }
          metrics.decoded += 1;
          recoveryAttempt = 0;
          if (stopped || (writer.desiredSize != null && writer.desiredSize <= 0)) {
            metrics.writerDrops += 1;
            frame.close();
            return;
          }
          let encoderFrame: VideoFrame;
          const normalizationStarted = performance.now();
          try { encoderFrame = normalizeFrame(frame); }
          catch (error) {
            frame.close();
            console.warn('[ScreenShare] Could not normalize encoder surface:', error);
            finish();
            return;
          }
          if (encoderFrame !== frame) { frame.close(); metrics.normalizedFrames += 1; }
          metrics.normalizationTimeMs += performance.now() - normalizationStarted;
          if (initial) resolveFirstFrame(true);
          const writeStarted = performance.now();
          void writer.write(encoderFrame).then(
            () => {
              metrics.delivered += 1;
              metrics.writeTimeMs += performance.now() - writeStarted;
              encoderFrame.close();
            },
            () => {
              encoderFrame.close();
              finish();
            },
          );
        },
        error: (error) => {
          if (!stopped && generation === runGeneration) console.warn('[ScreenShare] H.264 decoder failed:', error);
          if (generation === runGeneration) finish();
        },
      });
      decoderForRun = sessionDecoder;
      decoder = sessionDecoder;
      sessionDecoder.configure({
        codec,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
        // Chromium's AVC registration accepts Annex B when no avcC is supplied.
        avc: { format: 'annexb' },
      } as VideoDecoderConfig & { avc: { format: 'annexb' } });

      const parser = new H264AccessUnitParser();
      const reader = response.body.getReader();
      const clockOrigin = performance.now();
      const frameDuration = Math.round(1_000_000 / Math.max(1, runOptions.frameRate));
      const queueLimit = maxPendingDecodeFrames(runOptions.frameRate);
      let waitingForKeyframe = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        metrics.reads += 1;
        metrics.bytes += value.byteLength;
        const units = parser.push(value);
        metrics.accessUnits += units.length;
        if (units.length > 1) metrics.multiUnitReads += 1;
        metrics.maxUnitsPerRead = Math.max(metrics.maxUnitsPerRead, units.length);
        // A buffered read may contain multiple GOPs. Resume from its newest
        // keyframe rather than decoding frames that have already become stale.
        let newestKeyframe = -1;
        for (let i = 0; i < units.length; i++) {
          if (units[i]!.key) newestKeyframe = i;
        }
        const latest = newestKeyframe > 0 ? units.slice(newestKeyframe) : units;
        metrics.bufferedDrops += units.length - latest.length;
        timestamp += (units.length - latest.length) * frameDuration;
        for (const unit of latest) {
          if (stopped || generation !== runGeneration) return;
          // HTTP arrival time is not frame time: a read may contain several
          // frames. Keep their nominal spacing and only catch up after a stall.
          const elapsedUs = Math.round((performance.now() - clockOrigin) * 1_000);
          const frameTimestamp = Math.max(timestamp, elapsedUs - 250_000);
          if (metrics.submitted > 0) {
            const gap = frameTimestamp - (timestamp - frameDuration);
            metrics.timestampGapUs += gap;
            metrics.timestampSamples += 1;
            if (gap < 8_000) metrics.shortTimestampGaps += 1;
          }
          timestamp = frameTimestamp + frameDuration;
          if (!unit.key && shouldDropDeltaFrame(waitingForKeyframe, sessionDecoder.decodeQueueSize, queueLimit)) {
            metrics.recoveryDrops += 1;
            waitingForKeyframe = true;
            continue;
          }
          if (unit.key) waitingForKeyframe = false;
          metrics.submitted += 1;
          metrics.maxDecodeQueue = Math.max(metrics.maxDecodeQueue, sessionDecoder.decodeQueueSize);
          sessionDecoder.decode(new EncodedVideoChunk({
            type: unit.key ? 'key' : 'delta',
            timestamp: frameTimestamp,
            data: unit.data,
          }));
        }
      }
      await sessionDecoder.flush();
    } catch (error) {
      if (!stopped && generation === runGeneration && !runController.signal.aborted) {
        console.warn('[ScreenShare] Native capture ended:', error);
      }
    }
    if (decoder === decoderForRun && decoderForRun) {
      if (decoderForRun.state !== 'closed') decoderForRun.close();
      decoder = null;
    }
    if (generation === runGeneration && !runController.signal.aborted) recoverCapture(generation);
    })();
  };

  startDecodeSession(session.url, activeController, runGeneration, desired, true);

  const received = await firstFrame;
  clearTimeout(timeout);
  if (!received || generator.readyState === 'ended') {
    stop();
    return null;
  }
  return track;
}

export function setNativeScreenCaptureResolution(
  track: MediaStreamTrack,
  size: { width: number; height: number } | undefined,
): boolean {
  const nativeTrack = track as NativeScreenCaptureTrack;
  if (!nativeTrack.setResolution) return false;
  nativeTrack.setResolution(size);
  return true;
}

export function setNativeScreenCaptureFrameRate(track: MediaStreamTrack, rate: number): boolean {
  const nativeTrack = track as NativeScreenCaptureTrack;
  if (!nativeTrack.setFrameRate) return false;
  nativeTrack.setFrameRate(rate);
  return true;
}

export function setNativeScreenCaptureBitrate(track: MediaStreamTrack, bitrateKbps: number): boolean {
  const nativeTrack = track as NativeScreenCaptureTrack;
  if (!nativeTrack.setBitrate) return false;
  nativeTrack.setBitrate(bitrateKbps);
  return true;
}

export function setNativeScreenCaptureCursorMode(track: MediaStreamTrack, mode: 'auto' | 'show' | 'hide'): boolean {
  const nativeTrack = track as NativeScreenCaptureTrack;
  if (!nativeTrack.setCursorMode) return false;
  nativeTrack.setCursorMode(mode);
  return true;
}
