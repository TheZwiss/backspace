import { STANDARD_FRAMERATES, WIDTH_MAP } from '@backspace/shared/src/constants';

/**
 * A 16:9 capture mode a camera was measured to deliver: the frame size and the
 * highest standard frame rate it holds at that size.
 */
export interface CameraMode {
  width: number;
  height: number;
  maxFps: number;
}

export interface CameraCapture {
  width: number;
  height: number;
  frameRate: number;
}

/** Heights tried when measuring a camera, largest first. All are 16:9. */
const PROBE_HEIGHTS: readonly number[] = [2160, 1440, 1080, 720, 540, 360];
const PROBE_WIDTHS: Record<number, number> = { ...WIDTH_MAP, 360: 640 };
const FALLBACK_FPS = 30;

type Listener = () => void;

const modeCache = new Map<string, readonly CameraMode[]>();
const inflight = new Map<string, Promise<readonly CameraMode[]>>();
const listeners = new Set<Listener>();

/** Cache key for a camera selection; `null` is the browser's automatic pick. */
export function cameraModeKey(deviceId: string | null): string {
  return deviceId ?? 'default';
}

export function getCachedCameraModes(deviceId: string | null): readonly CameraMode[] | null {
  return modeCache.get(cameraModeKey(deviceId)) ?? null;
}

export function subscribeCameraModes(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam and device-change hook: forget what was measured. */
export function clearCameraModeCache(): void {
  modeCache.clear();
  inflight.clear();
  listeners.forEach((l) => l());
}

function rangeMax(range: number | { max?: number } | undefined, fallback: number): number {
  if (typeof range === 'number') return range;
  return range?.max ?? fallback;
}

async function tryConstraints(track: MediaStreamTrack, constraints: MediaTrackConstraints): Promise<boolean> {
  try {
    await track.applyConstraints(constraints);
    return true;
  } catch {
    return false;
  }
}

/**
 * Measure a live camera track by asking for each 16:9 size with exact
 * constraints and reading back what the device settled on. The track is left
 * on the last mode applied; callers that care re-apply their own constraints.
 * Capabilities alone are not enough: they report ranges, not the sizes the
 * sensor actually offers, which is how a 720p request lands on 640x480.
 */
export async function probeCameraTrack(track: MediaStreamTrack): Promise<CameraMode[]> {
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const maxHeight = rangeMax(caps.height as { max?: number } | undefined, Infinity);
  const maxFps = rangeMax(caps.frameRate as { max?: number } | undefined, FALLBACK_FPS);
  const fpsCandidates = [...STANDARD_FRAMERATES].filter((f) => f <= Math.max(maxFps, FALLBACK_FPS)).reverse();

  const modes: CameraMode[] = [];
  for (const height of PROBE_HEIGHTS) {
    if (height > maxHeight) continue;
    const width = PROBE_WIDTHS[height];
    if (!width) continue;
    if (track.readyState !== 'live') break;
    const applied = await tryConstraints(track, { width: { exact: width }, height: { exact: height } });
    if (!applied) continue;
    const settings = track.getSettings();
    if (settings.width !== width || settings.height !== height) continue;

    // A camera that cannot exceed the fallback rate has one candidate, and the
    // size just applied already delivered a frame rate: read it back instead of
    // spending another capture restart confirming it.
    let best = 0;
    for (const fps of fpsCandidates.length > 1 ? fpsCandidates : []) {
      if (!(await tryConstraints(track, { width: { exact: width }, height: { exact: height }, frameRate: { exact: fps } }))) continue;
      best = fps;
      break;
    }
    if (best === 0) {
      const reported = Math.round(track.getSettings().frameRate ?? FALLBACK_FPS);
      best = reported > 0 ? reported : FALLBACK_FPS;
    }
    modes.push({ width, height, maxFps: best });
  }
  return modes;
}

function store(key: string, modes: readonly CameraMode[]): readonly CameraMode[] {
  modeCache.set(key, modes);
  listeners.forEach((l) => l());
  return modes;
}

/**
 * Record the result of probing a track the caller already owns (the settings
 * preview), so no second camera open is needed. Returns the measured modes.
 */
export async function probeAndCacheTrack(deviceId: string | null, track: MediaStreamTrack): Promise<readonly CameraMode[]> {
  const key = cameraModeKey(deviceId);
  const cached = modeCache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = probeCameraTrack(track)
    .then((modes) => (modes.length > 0 ? store(key, modes) : modes))
    .finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}

/**
 * The 16:9 modes of a camera, measured once per device and kept for the
 * session. Opens the camera briefly when nothing is cached, so call it only
 * where the camera is about to be used anyway (starting the camera), never
 * from a passive screen. Resolves to an empty list when the camera cannot be
 * opened or offers no 16:9 mode; that result is not cached.
 */
export async function resolveCameraModes(deviceId: string | null): Promise<readonly CameraMode[]> {
  const key = cameraModeKey(deviceId);
  const cached = modeCache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async (): Promise<readonly CameraMode[]> => {
    if (!navigator.mediaDevices?.getUserMedia) return [];
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) return [];
      const modes = await probeCameraTrack(track);
      return modes.length > 0 ? store(key, modes) : modes;
    } catch {
      return [];
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}

/**
 * Fit the wanted height and frame rate to what the camera offers. Resolution
 * wins over frame rate: the largest mode not above the wanted height (or the
 * smallest one when all are larger), then the frame rate clamped to that
 * mode. Null when no mode is known, so the caller keeps its own constraints.
 */
export function pickCameraCapture(
  modes: readonly CameraMode[],
  wantedHeight: number,
  wantedFps: number,
): CameraCapture | null {
  if (modes.length === 0) return null;
  const sorted = [...modes].sort((a, b) => a.height - b.height);
  const fitting = sorted.filter((m) => m.height <= wantedHeight);
  const mode = fitting.length > 0 ? fitting[fitting.length - 1] : sorted[0];
  if (!mode) return null;
  return { width: mode.width, height: mode.height, frameRate: Math.min(wantedFps, mode.maxFps) };
}

/** Heights and frame rates a camera can deliver, for the settings choices. */
export function supportedCameraChoices(modes: readonly CameraMode[]): { heights: Set<number>; maxFpsByHeight: Map<number, number> } {
  return {
    heights: new Set(modes.map((m) => m.height)),
    maxFpsByHeight: new Map(modes.map((m) => [m.height, m.maxFps])),
  };
}

/**
 * Open the camera for the settings preview at the wanted 16:9 size. The first
 * open of a device also measures its modes on that same track, so the
 * settings can offer only what the camera delivers and no second open (and no
 * second light) is needed. The measuring runs after the stream is returned.
 */
export async function openCameraPreview(
  deviceId: string | null,
  wantedHeight: number,
  wantedFps: number,
): Promise<MediaStream> {
  const fit = (modes: readonly CameraMode[] | null): MediaTrackConstraints => {
    const picked = modes ? pickCameraCapture(modes, wantedHeight, wantedFps) : null;
    const width = picked?.width ?? PROBE_WIDTHS[wantedHeight] ?? Math.round((wantedHeight * 16) / 9);
    return {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: width },
      height: { ideal: picked?.height ?? wantedHeight },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: picked?.frameRate ?? wantedFps },
    };
  };

  const stream = await navigator.mediaDevices.getUserMedia({ video: fit(getCachedCameraModes(deviceId)) });
  const track = stream.getVideoTracks()[0];
  if (track && !getCachedCameraModes(deviceId)) {
    void probeAndCacheTrack(deviceId, track)
      .then(async (modes) => {
        if (track.readyState !== 'live') return;
        const picked = pickCameraCapture(modes, wantedHeight, wantedFps);
        if (!picked) return;
        await tryConstraints(track, { width: { ideal: picked.width }, height: { ideal: picked.height }, aspectRatio: { ideal: 16 / 9 }, frameRate: { ideal: picked.frameRate } });
      })
      .catch(() => {});
  }
  return stream;
}
