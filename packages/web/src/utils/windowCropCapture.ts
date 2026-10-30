import { getElectronAPI } from '../platform/platform';

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
  monitor: { width: number; height: number };
  crop: { x: number; y: number; width: number; height: number };
  minimized: boolean;
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

/** How often the window's place on the display is re-read while it is shared. */
const GEOMETRY_POLL_MS = 1_000;
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
  options: { frameRate: number; destination?: { width: number; height: number }; sourceId: string },
): Promise<MediaStreamTrack | null> {
  const api = getElectronAPI();
  const source = stream.getVideoTracks()[0];
  if (!api?.getWindowCaptureTarget || !source) return null;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context) { source.stop(); return null; }

  let current = target;
  let destination = options.destination;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameRequest: number | null = null;
  const useVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  let output: MediaStream | null = null;

  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    if (frameRequest !== null) {
      if (useVideoFrameCallback) video.cancelVideoFrameCallback?.(frameRequest);
      else cancelAnimationFrame(frameRequest);
    }
    video.srcObject = null;
    source.stop();
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

  const draw = (): void => {
    if (stopped) return;
    if (current.minimized) return;
    const frame = { width: video.videoWidth, height: video.videoHeight };
    if (!frame.width || !frame.height) return;
    const region = computeCropRegion(current.crop, current.monitor, frame);
    if (canvas.width === 0 || canvas.height === 0) fitCanvas();
    context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  };

  const schedule = (): void => {
    if (stopped) return;
    if (useVideoFrameCallback) {
      frameRequest = video.requestVideoFrameCallback(() => { draw(); schedule(); });
    } else {
      frameRequest = requestAnimationFrame(() => { draw(); schedule(); });
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
  output = canvas.captureStream(options.frameRate);
  const track = output.getVideoTracks()[0];
  if (!track) { teardown(); return null; }

  // Keep the crop following the window: it can be moved, resized, or minimized
  // while the share runs. A window that moved to another display cannot be
  // followed by this capture (the display was fixed when it started), so the
  // track ends and the UI reports the share as stopped rather than showing a
  // rectangle of the wrong monitor.
  timer = setInterval(() => {
    void api.getWindowCaptureTarget!(options.sourceId).then((next) => {
      if (stopped) return;
      if (!next || next.screenSourceId !== current.screenSourceId) {
        track.stop();
        teardown();
        track.dispatchEvent(new Event('ended'));
        return;
      }
      const moved = next.crop.x !== current.crop.x || next.crop.y !== current.crop.y
        || next.crop.width !== current.crop.width || next.crop.height !== current.crop.height
        || next.minimized !== current.minimized;
      current = next;
      if (moved) fitCanvas();
    }).catch(() => { /* a failed poll keeps the last known rectangle */ });
  }, GEOMETRY_POLL_MS);

  // The quality drawer can change the resolution while the setup screen is
  // open. A canvas track has no capture constraints to renegotiate, so the new
  // size is handed to the draw loop instead.
  (track as WindowCropTrack).setDestination = (size) => {
    destination = size;
    fitCanvas();
  };

  const stopTrack = track.stop.bind(track);
  track.stop = (): void => { stopTrack(); teardown(); };
  track.addEventListener('ended', teardown, { once: true });

  schedule();
  return track;
}
