import { getElectronAPI } from '../platform/platform';
import i18n from '../i18n';
import { FrameCadence } from './frameCadence';

/**
 * Borderless window sharing on Windows.
 *
 * Sharing a single window through Chromium means Windows Graphics Capture, and
 * on Windows 10 (build 19045, the last one) that API paints a yellow border
 * around the captured window for as long as the capture runs. There is no
 * supported way to turn it off before Windows 11 22H2, which is why OBS shows
 * the border too and its BitBlt fallback cannot see GPU-composited windows
 * (Chrome, Brave, Electron) at all.
 *
 * Discord does not show it, and its capture stack says why: its window source
 * is `dxgi_window_source`, a display duplication cropped to the window's
 * rectangle, not a window capture. A display capture never draws the border.
 *
 * This module does the same thing in the renderer: the desktop app reports
 * where the window is, the screen it is on is captured, and every frame of
 * that capture is cropped to the window's rectangle on a canvas. The canvas
 * is the published track. What a display crop cannot do is hide a window that
 * is on top of the shared one; that window is in the crop, as it is in
 * Discord's.
 */

/** Where the window is, in physical display pixels (the helper's units). */
export interface WindowCaptureTarget {
  screenSourceId: string;
  /** The display being captured, in physical pixels. */
  monitor: { x: number; y: number; width: number; height: number };
  crop: { x: number; y: number; width: number; height: number };
  minimized: boolean;
  /** True while the shared window is the one the user is working in. */
  foreground: boolean;
  /** A D3D app holds the display in exclusive fullscreen; frames may stall. */
  exclusive: boolean;
  /** The owning executable matches a known or manually bound game. */
  isGame?: boolean;
}

/** One line of `geometry-watch`: physical pixels, the helper's own units. */
interface WindowGeometrySnapshot {
  window: [number, number, number, number];
  monitor: [number, number, number, number];
  minimized: boolean;
  foreground: boolean;
  exclusive: boolean;
}

/**
 * Fold a geometry snapshot into the capture target, or null when the window can
 * no longer be shown from this capture (it left the display that is being
 * captured, or is too small to be worth a frame).
 */
export function applyWindowGeometry(current: WindowCaptureTarget, snapshot: unknown): WindowCaptureTarget | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const geometry = snapshot as WindowGeometrySnapshot;
  if (!Array.isArray(geometry.window) || geometry.window.length !== 4) return null;
  if (!Array.isArray(geometry.monitor) || geometry.monitor.length !== 4) return null;
  // A minimized window keeps the share alive: it shows the paused card until it
  // is restored, and only closing it ends the track (the helper stops, the
  // renderer gets 'ended'). Its monitor can also be reported differently while
  // it has no screen presence, so the last rectangle is kept as it is.
  if (geometry.minimized === true) {
    return { ...current, minimized: true, foreground: false, exclusive: false };
  }
  const [monitorX, monitorY, monitorWidth, monitorHeight] = geometry.monitor;
  if (monitorX !== current.monitor.x || monitorY !== current.monitor.y
    || monitorWidth !== current.monitor.width || monitorHeight !== current.monitor.height) {
    return null;
  }
  const [windowX, windowY, windowWidth, windowHeight] = geometry.window;
  const left = Math.max(monitorX, windowX);
  const top = Math.max(monitorY, windowY);
  const right = Math.min(monitorX + monitorWidth, windowX + windowWidth);
  const bottom = Math.min(monitorY + monitorHeight, windowY + windowHeight);
  if (right - left < 16 || bottom - top < 16) return null;
  return {
    ...current,
    crop: { x: left - monitorX, y: top - monitorY, width: right - left, height: bottom - top },
    minimized: false,
    foreground: geometry.foreground === true,
    exclusive: geometry.exclusive === true,
  };
}

/**
 * One step of exponential smoothing towards the target rectangle, so a window
 * being dragged does not make the crop jump between 100 ms snapshots. A jump
 * too large to be a drag (a restore, a display change) snaps instead of sliding
 * through the pixels in between.
 */
export function easeCrop(from: CropRect, to: CropRect, factor = 0.35): CropRect {
  if (Math.abs(to.x - from.x) + Math.abs(to.y - from.y) > 240) return to;
  return {
    x: from.x + (to.x - from.x) * factor,
    y: from.y + (to.y - from.y) * factor,
    width: from.width + (to.width - from.width) * factor,
    height: from.height + (to.height - from.height) * factor,
  };
}

/**
 * Whether viewers should see the window's pixels.
 *
 * The capture is the display behind the window, so a window that lost focus is
 * the one case where drawing it would show whatever is on top — the app the
 * user switched to. While the share is live, that frame is replaced by a paused
 * card; the audio is a separate track and keeps flowing. Before the share is
 * published (the setup screen) this is ignored: the app is focused then, so
 * every preview would be the card instead of the window the user is choosing.
 */
export function isCaptureActive(target: Pick<WindowCaptureTarget, 'foreground' | 'minimized'>): boolean {
  return target.foreground && !target.minimized;
}

/** Frames that stopped arriving while an exclusive-fullscreen D3D app runs are not a dead share. */
export const CAPTURE_STALL_MS = 3_000;

/**
 * Whether the capture has gone quiet because the shared display is held by an
 * exclusive-fullscreen D3D app. That app bypasses the compositor, so the display
 * capture can stop delivering frames until it leaves fullscreen; the share keeps
 * running (and its audio keeps flowing) and recovers by itself.
 */
export function isCaptureStalled(target: Pick<WindowCaptureTarget, 'exclusive'>, msSinceFrame: number): boolean {
  return target.exclusive && msSinceFrame > CAPTURE_STALL_MS;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Desktop source ids for windows are `window:<handle>:<index>`. */
export function isWindowSourceId(sourceId: string | null | undefined): boolean {
  return typeof sourceId === 'string' && /^window:\d+:\d+$/.test(sourceId);
}

/** Whether this build can take the cropped path at all. */
export function canCropCaptureWindow(): boolean {
  const api = getElectronAPI();
  return typeof api?.getWindowCaptureTarget === 'function'
    && typeof api?.preselectScreenSource === 'function'
    && api?.platform === 'win32';
}

/**
 * Map the window's physical-pixel rectangle onto the captured frame.
 *
 * The frame is the whole display, and Chromium may have scaled it (a 4K
 * display captured at the encoder's size, or a display with scaling), so the
 * two coordinate spaces are reconciled by their ratio rather than assumed
 * equal. The result is clamped into the frame: a window dragged half off the
 * screen still yields a rectangle inside the image.
 */
export function computeCropRegion(
  crop: CropRect,
  monitor: { width: number; height: number },
  frame: { width: number; height: number },
): CropRect {
  const scaleX = frame.width / Math.max(1, monitor.width);
  const scaleY = frame.height / Math.max(1, monitor.height);
  const x = Math.min(Math.max(0, Math.round(crop.x * scaleX)), Math.max(0, frame.width - 2));
  const y = Math.min(Math.max(0, Math.round(crop.y * scaleY)), Math.max(0, frame.height - 2));
  const width = Math.min(Math.max(2, Math.round(crop.width * scaleX)), frame.width - x);
  const height = Math.min(Math.max(2, Math.round(crop.height * scaleY)), frame.height - y);
  return { x, y, width, height };
}

/**
 * Size of the canvas the crop is drawn onto: the configured resolution when
 * the share has one, keeping the window's aspect ratio, else the crop's own
 * pixels. Even dimensions only — odd sizes make some encoders pad.
 */
export function computeDestinationSize(
  region: CropRect,
  target?: { width: number; height: number },
): { width: number; height: number } {
  const even = (value: number): number => Math.max(2, value - (value % 2));
  if (!target || target.width <= 0 || target.height <= 0) {
    return { width: even(region.width), height: even(region.height) };
  }
  const ratio = region.width / Math.max(1, region.height);
  let width = target.width;
  let height = Math.round(width / ratio);
  if (height > target.height) {
    height = target.height;
    width = Math.round(height * ratio);
  }
  return { width: even(width), height: even(height) };
}

/** A cropped-window track, which carries its own resize hook. */
export interface WindowCropTrack extends MediaStreamTrack {
  setDestination?: (size: { width: number; height: number } | undefined) => void;
  setFrameRate?: (rate: number) => void;
  setCursorMode?: (mode: 'auto' | 'show' | 'hide') => void;
  setLive?: (live: boolean) => void;
}

export interface OpenWindowCropTrackOptions {
  frameRate: number;
  destination?: { width: number; height: number };
  sourceId: string;
  cursorMode?: 'auto' | 'show' | 'hide';
  /**
   * Reopen the display source after a display change or ended capture. The
   * caller can use the desktop capture API with `chromeMediaSourceNoCursor`
   * when supported. Returning null is a failed attempt; this path deliberately
   * does not fall through to Chromium's cursor-bearing capture APIs.
   */
  reopenDisplay?: (screenSourceId: string, cursorMode: 'auto' | 'show' | 'hide') => Promise<MediaStreamTrack | null | undefined>;
}

export function classifyCustomDisplayReopen(
  track: MediaStreamTrack | null | undefined,
  cursorFreeRequired: boolean,
): 'source' | 'fallback' | 'failed' {
  if (track) return 'source';
  if (track === null || cursorFreeRequired) return 'failed';
  return 'fallback';
}

/** Tell a cropped-window track that its share is published, if it is one. */
export function setWindowCropLive(track: MediaStreamTrack, live: boolean): boolean {
  const crop = track as WindowCropTrack;
  if (typeof crop.setLive !== 'function') return false;
  crop.setLive(live);
  return true;
}

/** Resize a cropped-window track, if it is one. Returns whether it was. */
export function setWindowCropResolution(
  track: MediaStreamTrack,
  size: { width: number; height: number } | undefined,
): boolean {
  const crop = track as WindowCropTrack;
  if (typeof crop.setDestination !== 'function') return false;
  crop.setDestination(size);
  return true;
}

export function setWindowCropFrameRate(track: MediaStreamTrack, rate: number): boolean {
  const crop = track as WindowCropTrack;
  if (!crop.setFrameRate) return false;
  crop.setFrameRate(rate);
  return true;
}

export function setWindowCropCursorMode(track: MediaStreamTrack, mode: 'auto' | 'show' | 'hide'): boolean {
  const crop = track as WindowCropTrack;
  if (!crop.setCursorMode) return false;
  crop.setCursorMode(mode);
  return true;
}

/**
 * How often the window's place on the display and its focus are re-read while
 * it is shared. Focus is what decides between the window and the paused card,
 * so this is short enough to feel like a reaction to clicking away.
 */
const GEOMETRY_POLL_MS = 500;
/** After this long without a snapshot, the last one is not trusted (see draw). */
const GEOMETRY_STALE_MS = 1_500;
/** A window that cannot produce a first frame in this time is not worth waiting for. */
const FIRST_FRAME_TIMEOUT_MS = 5_000;

/**
 * Crop `stream` (a display capture containing the window) to `target` and
 * return the canvas track. Returns null when no frame ever arrives, so the
 * caller can keep the ordinary window capture instead of publishing a frozen
 * or black surface.
 *
 * The display track is stopped by this function once the cropped track exists
 * (or when it gives up): the caller publishes the returned track only.
 */
export async function openWindowCropTrack(
  stream: MediaStream,
  target: WindowCaptureTarget,
  options: OpenWindowCropTrackOptions,
): Promise<MediaStreamTrack | null> {
  const api = getElectronAPI();
  const initialSource = stream.getVideoTracks()[0];
  if (!initialSource) return null;
  let source: MediaStreamTrack = initialSource;
  // Set once recapture exists. A display capture that Chromium ends (a display
  // mode change when a game enters or leaves exclusive fullscreen, a driver
  // reset) is a reason to take it again, not to end the share.
  let handleSourceEnded = (): void => { /* replaced below */ };
  const attachSource = (track: MediaStreamTrack): void => {
    track.addEventListener('ended', () => handleSourceEnded(), { once: true });
  };
  attachSource(initialSource);
  if (!api?.getWindowCaptureTarget || !source) return null;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context) { source.stop(); return null; }

  let current = target;
  let desiredCursorMode = options.cursorMode ?? 'auto';
  const shouldHideCursor = (mode = desiredCursorMode): boolean =>
    mode === 'hide' || (mode === 'auto' && current.isGame === true);
  let destination = options.destination;
  const cadence = new FrameCadence(options.frameRate);
  let requestCanvasFrame = (): void => {};
  let live = false;
  /** The rectangle actually drawn, chased towards the target so moves look smooth. */
  let drawnRegion: CropRect | null = null;
  let stopGeometry: (() => void) | null = null;
  let lastFrameAt = Date.now();
  /** When the last geometry snapshot arrived; a stale one must never freeze the share. */
  let lastGeometryAt = Date.now();
  let reconnecting = false;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameRequest: number | null = null;
  const useVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  let output: MediaStream | null = null;

  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    if (watchdog !== null) clearInterval(watchdog);
    if (frameRequest !== null) {
      if (useVideoFrameCallback) video.cancelVideoFrameCallback?.(frameRequest);
      else cancelAnimationFrame(frameRequest);
    }
    video.srcObject = null;
    source.stop();
    stopGeometry?.();
    void api?.stopWindowGeometry?.(options.sourceId).catch(() => undefined);
    output?.getTracks().forEach((track) => track.stop());
  };

  const fitCanvas = (): void => {
    const frame = { width: video.videoWidth, height: video.videoHeight };
    if (!frame.width || !frame.height) return;
    const region = computeCropRegion(current.crop, current.monitor, frame);
    const size = computeDestinationSize(region, destination);
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
  };

  /**
   * What viewers see while the shared window is not the focused one: a dark card
   * with a pause mark and the localized label, drawn on the same canvas so the
   * published track carries it. The audio track is untouched.
   */
  const drawCard = (message: string, accent: string): void => {
    const width = canvas.width;
    const height = canvas.height;
    if (!width || !height) return;
    context.fillStyle = '#13131a';
    context.fillRect(0, 0, width, height);
    const icon = Math.max(24, Math.round(height * 0.16));
    const barWidth = Math.max(6, Math.round(icon * 0.22));
    const gap = Math.max(6, Math.round(icon * 0.2));
    const iconWidth = barWidth * 2 + gap;
    const iconX = Math.round((width - iconWidth) / 2);
    const iconY = Math.round(height * 0.42 - icon / 2);
    context.fillStyle = accent;
    context.fillRect(iconX, iconY, barWidth, icon);
    context.fillRect(iconX + barWidth + gap, iconY, barWidth, icon);
    const fontSize = Math.max(12, Math.round(height * 0.05));
    context.fillStyle = '#c9c9d4';
    context.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillText(message, width / 2, iconY + icon + Math.round(fontSize * 0.8));
    requestCanvasFrame();
  };

  const drawPaused = (): void => drawCard(i18n.t('voice:screenPicker.streamPaused'), '#7c6cf6');
  const drawReconnecting = (): void => drawCard(i18n.t('voice:screenPicker.captureReconnecting'), '#f0b74a');

  const draw = (force = false): void => {
    if (stopped) return;
    if (!force && !cadence.shouldDraw(performance.now())) return;
    if (canvas.width === 0 || canvas.height === 0) fitCanvas();
    // Geometry is the only thing that can say "paused". If it went quiet (the
    // watcher died, the helper was restarted) the last state is not trusted
    // forever: drawing the window again is better than a card that never lifts
    // until some unrelated action, which is what a stale unfocused snapshot did.
    const geometryIsFresh = Date.now() - lastGeometryAt <= GEOMETRY_STALE_MS;
    if (!geometryIsFresh) {
      // Hold whatever is on screen. Drawing the window here would flash it for
      // the second or two the watcher is being restarted, which is exactly what
      // a dead watcher used to look like to viewers.
      return;
    }
    if (live && !isCaptureActive(current)) { drawPaused(); return; }
    if (current.minimized) return;
    const frame = { width: video.videoWidth, height: video.videoHeight };
    if (!frame.width || !frame.height) return;
    const targetRegion = computeCropRegion(current.crop, current.monitor, frame);
    drawnRegion = drawnRegion ? easeCrop(drawnRegion, targetRegion) : targetRegion;
    const x = Math.round(drawnRegion.x);
    const y = Math.round(drawnRegion.y);
    const width = Math.max(2, Math.round(drawnRegion.width));
    const height = Math.max(2, Math.round(drawnRegion.height));
    context.drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
    requestCanvasFrame();
  };

  const schedule = (): void => {
    if (stopped) return;
    if (useVideoFrameCallback) {
      frameRequest = video.requestVideoFrameCallback(() => {
        lastFrameAt = Date.now();
        if (reconnecting) reconnecting = false;
        draw();
        schedule();
      });
    } else {
      frameRequest = requestAnimationFrame(() => {
        lastFrameAt = Date.now();
        if (reconnecting) reconnecting = false;
        draw();
        schedule();
      });
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const done = (): void => { cleanup(); resolve(); };
      const fail = (): void => { cleanup(); reject(new Error('window capture produced no frame')); };
      const timerId = setTimeout(fail, FIRST_FRAME_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timerId);
        video.removeEventListener('loadeddata', done);
        video.removeEventListener('error', fail);
      };
      video.addEventListener('loadeddata', done, { once: true });
      video.addEventListener('error', fail, { once: true });
      void video.play().catch(() => { /* autoplay of a muted element is allowed; a rejection is caught by the timeout */ });
    });
  } catch {
    teardown();
    return null;
  }

  fitCanvas();
  output = canvas.captureStream(0);
  // Explicit frame requests let a quality change alter cadence on the same track.
  if (typeof (output.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined)?.requestFrame !== 'function') {
    output.getTracks().forEach(track => track.stop());
    output = canvas.captureStream();
  }
  const track = output.getVideoTracks()[0];
  if (!track) { teardown(); return null; }
  requestCanvasFrame = () => (track as CanvasCaptureMediaStreamTrack).requestFrame?.();

  const endTrack = (): void => {
    track.stop();
    teardown();
    track.dispatchEvent(new Event('ended'));
  };

  /** Swap the display behind the crop without touching the published canvas track. */
  const switchSource = async (next: MediaStreamTrack): Promise<boolean> => {
    const previous = source;
    attachSource(next);
    video.srcObject = new MediaStream([next]);
    try {
      await new Promise<void>((resolve, reject) => {
        const timerId = setTimeout(() => reject(new Error('new display produced no frame')), FIRST_FRAME_TIMEOUT_MS);
        const done = (): void => { clearTimeout(timerId); resolve(); };
        video.addEventListener('loadeddata', done, { once: true });
        video.addEventListener('error', () => { clearTimeout(timerId); reject(new Error('new display failed')); }, { once: true });
        void video.play().catch(() => undefined);
      });
    } catch {
      video.srcObject = new MediaStream([previous]);
      return false;
    }
    source = next;
    previous.stop();
    drawnRegion = null;
    return true;
  };

  let recapturing = false;
  let recaptureAttempts = 0;
  let cursorModeGeneration = 0;

  const synchronizeCursorSource = async (): Promise<void> => {
    while (!stopped) {
      const generation = cursorModeGeneration;
      const mode = desiredCursorMode;
      const effectiveMode = shouldHideCursor(mode) ? 'hide' : 'show';
      const currentNativeSource = source as MediaStreamTrack & { setCursorMode?: (value: 'auto' | 'show' | 'hide') => void };
      if (currentNativeSource.setCursorMode) {
        currentNativeSource.setCursorMode(effectiveMode);
        return;
      }
      if (!shouldHideCursor(mode)) return;

      const nextSource = await reopenDisplay(current.screenSourceId, mode);
      if (generation !== cursorModeGeneration) {
        nextSource?.stop();
        continue;
      }
      if (!nextSource) {
        console.warn('[WindowCapture] Cursor-free source unavailable for the selected cursor mode.');
        endTrack();
        return;
      }
      if (!await switchSource(nextSource)) {
        nextSource.stop();
        endTrack();
        return;
      }
      const replacement = source as MediaStreamTrack & { setCursorMode?: (value: 'auto' | 'show' | 'hide') => void };
      replacement.setCursorMode?.(shouldHideCursor(desiredCursorMode) ? 'hide' : 'show');
      if (generation === cursorModeGeneration) return;
    }
  };

  /**
   * Take the display again without a user gesture.
   *
   * `getDisplayMedia` needs transient activation, and a capture that has to be
   * restarted (window moved to another monitor, a display mode change ended the
   * old track) has no click behind it. Electron still honours the desktop
   * constraint form, which needs none; `getDisplayMedia` stays as the fallback
   * for a build where it does not.
   */
  const reopenDisplay = async (
    screenSourceId: string,
    mode = desiredCursorMode,
  ): Promise<MediaStreamTrack | null> => {
    if (options.reopenDisplay) {
      try {
        const custom = await options.reopenDisplay(screenSourceId, mode);
        const result = classifyCustomDisplayReopen(custom, shouldHideCursor(mode));
        if (result === 'source') return custom!;
        if (result === 'failed') return null;
      } catch (err) {
        console.warn('[ScreenShare] Custom display recapture failed:', err);
        if (shouldHideCursor(mode)) return null;
      }
    }
    if (shouldHideCursor(mode)) return null;
    try {
      const legacy = navigator.mediaDevices as unknown as {
        getUserMedia: (constraints: unknown) => Promise<MediaStream>;
      };
      const stream = await legacy.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screenSourceId,
            maxFrameRate: cadence.rate,
          },
        },
      });
      const track = stream.getVideoTracks()[0] ?? null;
      if (track) return track;
    } catch (err) {
      console.warn('[ScreenShare] Desktop-constraint capture failed, trying getDisplayMedia:', err);
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: cadence.rate },
        audio: false,
      });
      return stream.getVideoTracks()[0] ?? null;
    } catch (err) {
      console.warn('[ScreenShare] getDisplayMedia for the new display failed:', err);
      return null;
    }
  };

  /**
   * A capture that cannot be restarted right now (the display is held by an
   * exclusive-fullscreen game, the driver is resetting) is retried, not fatal:
   * the card stays up and the share survives. Only a run of failures ends it.
   */
  const scheduleRecaptureRetry = (): void => {
    if (stopped) return;
    recaptureAttempts += 1;
    if (recaptureAttempts > 5) { endTrack(); return; }
    setTimeout(() => { if (!stopped) void recapture(true); }, 2_000);
  };

  /**
   * The window was dragged to another monitor. The display being captured no
   * longer contains it, so capture the new one and swap it underneath the same
   * canvas: the published track never changes, viewers see a short reconnecting
   * card instead of the share ending, and the audio (the window's process tree)
   * is untouched.
   */
  const recapture = async (force = false): Promise<void> => {
    if (stopped || recapturing) return;
    recapturing = true;
    try {
      drawReconnecting();
      const next = await api.getWindowCaptureTarget!(options.sourceId);
      if (stopped) return;
      if (!next) { endTrack(); return; }
      if (!force && next.screenSourceId === current.screenSourceId) {
        current = next;
        fitCanvas();
        draw();
        await synchronizeCursorSource();
        return;
      }
      await api.preselectScreenSource!(next.screenSourceId, false, undefined, options.sourceId);
      const nextSource = await reopenDisplay(next.screenSourceId);
      if (!nextSource) { scheduleRecaptureRetry(); return; }
      const switched = await switchSource(nextSource);
      if (!switched) {
        nextSource.stop();
        scheduleRecaptureRetry();
        return;
      }
      recaptureAttempts = 0;
      current = next;
      fitCanvas();
      draw();
      await synchronizeCursorSource();
    } catch (err) {
      console.warn('[ScreenShare] Could not restart the capture on this display:', err);
      scheduleRecaptureRetry();
    } finally {
      recapturing = false;
    }
  };
  handleSourceEnded = () => { void recapture(true); };

  const applySnapshot = (snapshot: unknown): void => {
    const next = applyWindowGeometry(current, snapshot);
    // A window that left this display is recaptured on the new one (recapture);
    // a window that is gone ends the track.
    if (!next) { endTrack(); return; }
    const moved = next.crop.x !== current.crop.x || next.crop.y !== current.crop.y
      || next.crop.width !== current.crop.width || next.crop.height !== current.crop.height
      || next.minimized !== current.minimized || next.foreground !== current.foreground;
    current = next;
    if (moved) {
      fitCanvas();
      draw();
    }
  };

  // Keep the crop following the window: it can be moved, resized, minimized, or
  // focused and unfocused while the share runs. The desktop app streams the
  // rectangle from one long-lived helper process at 10 Hz, which is what lets a
  // dragged window follow smoothly; a build without that stream falls back to
  // asking for one snapshot on a timer.
  /**
   * The watcher died but may have died alone (a helper restart, a transient
   * spawn failure). Ask for the window once: if it still exists, subscribe
   * again and keep the share, instead of ending it on a stream hiccup.
   */
  const recoverGeometry = async (): Promise<void> => {
    const next = await api.getWindowCaptureTarget!(options.sourceId).catch(() => null);
    if (stopped) return;
    if (!next) { endTrack(); return; }
    current = next;
    lastGeometryAt = Date.now();
    fitCanvas();
    draw();
    if (api.startWindowGeometry && api.onWindowGeometry) {
      stopGeometry?.();
      stopGeometry = api.onWindowGeometry(handleSnapshot);
      void api.startWindowGeometry(options.sourceId).catch(() => undefined);
    }
  };

  const handleSnapshot = (snapshot: unknown): void => {
    if (stopped) return;
    if (snapshot === null) { void recoverGeometry(); return; }
    lastGeometryAt = Date.now();
    const geometry = snapshot as { monitor?: unknown };
    if (Array.isArray(geometry.monitor) && geometry.monitor.length === 4) {
      const [x, y, width, height] = geometry.monitor as number[];
      if (x !== current.monitor.x || y !== current.monitor.y
        || width !== current.monitor.width || height !== current.monitor.height) {
        void recapture(true);
        return;
      }
    }
    applySnapshot(snapshot);
  };

  if (api.startWindowGeometry && api.onWindowGeometry) {
    stopGeometry = api.onWindowGeometry(handleSnapshot);
    void api.startWindowGeometry(options.sourceId).catch(() => undefined);
  } else {
    timer = setInterval(() => {
      void api.getWindowCaptureTarget!(options.sourceId).then((next) => {
        if (stopped) return;
        lastGeometryAt = Date.now();
        if (!next) { endTrack(); return; }
        if (next.screenSourceId !== current.screenSourceId) { void recapture(true); return; }
        const moved = next.crop.x !== current.crop.x || next.crop.y !== current.crop.y
          || next.crop.width !== current.crop.width || next.crop.height !== current.crop.height
          || next.minimized !== current.minimized || next.foreground !== current.foreground;
        current = next;
        if (moved) {
          fitCanvas();
          draw();
        }
      }).catch(() => { /* a failed poll keeps the last known rectangle */ });
    }, GEOMETRY_POLL_MS);
  }

  // The quality drawer can change the resolution while the setup screen is
  // open. A canvas track has no capture constraints to renegotiate, so the new
  // size is handed to the draw loop instead.
  (track as WindowCropTrack).setDestination = (size) => {
    destination = size;
    fitCanvas();
  };
  let configuredSource = source;
  let configuredRate = cadence.rate;
  let configuringRate = false;
  const configureSourceRate = async (): Promise<void> => {
    if (configuringRate) return;
    configuringRate = true;
    try {
      while (!stopped && (configuredSource !== source || configuredRate !== cadence.rate)) {
        const currentSource = source;
        const rate = cadence.rate;
        const nativeSource = currentSource as MediaStreamTrack & { setFrameRate?: (frameRate: number) => void };
        if (nativeSource.setFrameRate) nativeSource.setFrameRate(rate);
        else {
          try { await currentSource.applyConstraints({ frameRate: { ideal: rate, max: rate } }); }
          catch (error) { console.warn('[WindowCapture] Could not update source cadence:', error); }
        }
        configuredSource = currentSource;
        configuredRate = rate;
      }
    } finally { configuringRate = false; }
  };
  (track as WindowCropTrack).setFrameRate = (rate) => {
    cadence.setRate(rate);
    void configureSourceRate();
  };
  (track as WindowCropTrack).setCursorMode = (mode) => {
    desiredCursorMode = mode;
    cursorModeGeneration += 1;
    const nativeSource = source as MediaStreamTrack & { setCursorMode?: (value: 'auto' | 'show' | 'hide') => void };
    if (nativeSource.setCursorMode) {
      nativeSource.setCursorMode(shouldHideCursor(mode) ? 'hide' : 'show');
      return;
    }
    if (!shouldHideCursor(mode) || recapturing || stopped) return;
    recapturing = true;
    void synchronizeCursorSource().catch((error) => {
      console.warn('[WindowCapture] Could not enable cursor-free source:', error);
    }).finally(() => { recapturing = false; });
  };
  // Published: from here on a window that loses focus shows the paused card.
  (track as WindowCropTrack).setLive = (value) => {
    live = value;
    if (value) draw(true);
  };

  // An exclusive-fullscreen D3D app bypasses the compositor, so this display
  // capture can go quiet while it holds the display. That is not a dead share:
  // show a reconnecting card (audio keeps flowing) and take the normal frame
  // back as soon as one arrives. No dialog, no choice for the user.
  let recovering = false;
  watchdog = setInterval(() => {
    if (stopped || !live) return;
    // A quiet watcher is restarted, not waited out: the helper can be stopped
    // by a superseded capture's teardown, and nothing else would bring it back.
    if (Date.now() - lastGeometryAt > 2_500 && !recovering) {
      recovering = true;
      void recoverGeometry().finally(() => { recovering = false; });
    }
    // A quiet watcher holds the last frame (draw does nothing while stale); the
    // recovery above brings the events back.
    if (Date.now() - lastGeometryAt > GEOMETRY_STALE_MS) return;
    if (!isCaptureActive(current)) return;
    const stalled = isCaptureStalled(current, Date.now() - lastFrameAt);
    if (stalled && !reconnecting) {
      reconnecting = true;
      drawReconnecting();
    } else if (!stalled && reconnecting) {
      reconnecting = false;
      draw();
    }
  }, 1_000);

  const stopTrack = track.stop.bind(track);
  track.stop = (): void => { stopTrack(); teardown(); };
  track.addEventListener('ended', teardown, { once: true });

  schedule();
  return track;
}
