import { openWindowsProcessAudio } from './windowsProcessAudio';
import { getElectronAPI } from '../platform/platform';

/**
 * System audio without Backspace's own playback, on the desktop app where
 * Chromium's loopback cannot leave it out (#358, Linux). The main process
 * routes every other app's playback into a virtual PipeWire source
 * (packages/desktop/src/systemAudio.ts); here that source is opened like a
 * microphone and its track replaces the loopback track of the share.
 */

/** How long the virtual source gets to show up in the device list after the link is made. */
const DEVICE_WAIT_MS = 3000;
const DEVICE_POLL_MS = 150;

/** Name the main process gives the virtual source (`SYSTEM_AUDIO_SOURCE_LABEL` in packages/desktop/src/systemAudio.ts). */
const SOURCE_LABEL = 'vencord-screen-share';

/** The virtual source is a capture device the app creates itself; it is not a microphone the user plugged in. */
export function isAppSystemAudioSource(device: Pick<MediaDeviceInfo, 'kind' | 'label'>): boolean {
  return device.kind === 'audioinput' && device.label.includes(SOURCE_LABEL);
}

/**
 * Whether this desktop app has the bridge the source needs. The web client
 * tells the main process so when it asks what a system-audio share carries
 * (`getSystemAudioCapability`): only a client that opens the source leaves
 * Backspace's own playback out on Linux.
 */
export function canOpenAppSystemAudioSource(): boolean {
  const api = getElectronAPI();
  return typeof api?.startSystemAudio === 'function' && typeof api.stopSystemAudio === 'function';
}

/**
 * The device list as the hot-plug handler compares it, without the virtual
 * source: that device comes and goes with a share and is no change the user
 * made. groupId and label are part of it because a change of the OS default
 * keeps every deviceId (the `default` entry included) and only relabels the
 * `default` entry, and the handler must still follow it.
 */
export function userDevicesSignature(devices: readonly MediaDeviceInfo[]): string {
  return devices
    .filter((d) => !isAppSystemAudioSource(d))
    .map((d) => JSON.stringify([d.kind, d.deviceId, d.groupId, d.label]))
    .sort()
    .join('\n');
}

type StartResult = Awaited<ReturnType<NonNullable<NonNullable<ReturnType<typeof getElectronAPI>>['startSystemAudio']>>>;

/**
 * Captures that are starting or hold the source. The main process has one
 * link, shared by all of them: it is made by the first and taken down by the
 * last, so one capture stopping (the setup screen discarding a preview, a late
 * toggle capture) never removes the source another one is reading.
 */
let holders = 0;
let starting: Promise<StartResult> | null = null;

/** `null` when the desktop app has no such source (or this is a browser): the caller keeps the loopback capture. */
export async function acquireAppExcludedSystemAudio(): Promise<MediaStreamTrack | null> {
  const api = getElectronAPI();
  if (!api?.startSystemAudio || !api.stopSystemAudio) return null;

  holders++;
  let dropped = false;
  /** Give up this capture's share of the source; the link goes with the last one. */
  const drop = (unlink: boolean): void => {
    if (dropped) return;
    dropped = true;
    if (--holders > 0) return;
    starting = null;
    if (unlink) void api.stopSystemAudio?.().catch(() => undefined);
  };

  try {
    starting ??= api.startSystemAudio();
    const result = await starting;
    if (!result.ok) {
      drop(false);
      if (api.platform === 'linux' || api.platform === 'win32' || result.reason === 'audio-target-required' || result.reason === 'process-capture-failed') throw new Error(result.reason);
      return null;
    }

    if (result.pcm) return await openWindowsProcessAudio(() => drop(true));

    const deviceId = await waitForDevice(result.label);
    if (!deviceId) {
      console.warn('[ScreenShare] The system-audio source did not appear in the device list');
      drop(true);
      return null;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      drop(true);
      return null;
    }
    // The link lives as long as the tracks: stopping one, by any path that
    // stops a capture track, gives up its share of it.
    const stopTrack = track.stop.bind(track);
    track.stop = (): void => {
      stopTrack();
      drop(true);
    };
    track.addEventListener('ended', () => drop(true), { once: true });
    return track;
  } catch (err) {
    console.warn('[ScreenShare] The system-audio source could not be started or opened:', err);
    // A start that threw may or may not have linked: take it down if nothing else holds it.
    drop(true);
    if (api.platform === 'linux' || api.platform === 'win32' || (err instanceof Error && err.message === 'audio-target-required')) throw err;
    return null;
  }
}

async function waitForDevice(label: string): Promise<string | null> {
  const deadline = Date.now() + DEVICE_WAIT_MS;
  for (;;) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const found = devices.find((d) => d.kind === 'audioinput' && d.label.includes(label));
    if (found) return found.deviceId;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, DEVICE_POLL_MS));
  }
}
