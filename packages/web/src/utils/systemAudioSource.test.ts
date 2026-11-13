import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  startSystemAudio: vi.fn(),
  stopSystemAudio: vi.fn(),
}));
const platform = vi.hoisted(() => ({ getElectronAPI: vi.fn() }));
const processAudio = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../platform/platform', () => platform);
vi.mock('./windowsProcessAudio', () => ({ openWindowsProcessAudio: processAudio.open }));

import { isAppSystemAudioSource, userDevicesSignature } from './systemAudioSource';

// The module keeps the shared-link count between calls; each test gets a fresh copy.
let acquireAppExcludedSystemAudio: typeof import('./systemAudioSource').acquireAppExcludedSystemAudio;

/**
 * #358: on the Linux desktop app the system audio of a share is the virtual
 * source the main process builds without Backspace's own playback. The track
 * must come from that source and take it down again when it stops.
 */

function fakeTrack() {
  const listeners = new Map<string, () => void>();
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
  };
  return { track: track as unknown as MediaStreamTrack, raw: track, listeners };
}

function stubMedia(devices: Array<Partial<MediaDeviceInfo>>, track: MediaStreamTrack | undefined) {
  const getUserMedia = vi.fn(async () => ({ getAudioTracks: () => (track ? [track] : []) }));
  const enumerateDevices = vi.fn(async () => devices as MediaDeviceInfo[]);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices } });
  return { getUserMedia, enumerateDevices };
}

beforeEach(async () => {
  vi.resetModules();
  ({ acquireAppExcludedSystemAudio } = await import('./systemAudioSource'));
  api.startSystemAudio.mockReset();
  api.stopSystemAudio.mockReset().mockResolvedValue(undefined);
  processAudio.open.mockReset();
  platform.getElectronAPI.mockReset().mockReturnValue(api);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('acquireAppExcludedSystemAudio', () => {
  it('returns null in a browser and on a desktop app without the bridge', async () => {
    platform.getElectronAPI.mockReturnValue(undefined);
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    platform.getElectronAPI.mockReturnValue({});
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
  });

  it('returns null, and opens nothing, when the main process has no source', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: false, reason: 'no-pipewire' });
    const media = stubMedia([], undefined);
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
  });

  it('returns null when starting throws, and unlinks in case it half-succeeded', async () => {
    api.startSystemAudio.mockRejectedValue(new Error('ipc'));
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('opens the virtual source by its device id, without voice processing', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const { track } = fakeTrack();
    const media = stubMedia(
      [
        { kind: 'audioinput', label: 'Default', deviceId: 'default' },
        { kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'virt-1' },
      ],
      track,
    );
    expect(await acquireAppExcludedSystemAudio()).toBe(track);
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'virt-1' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
  });

  it('opens the Windows PCM source as audio tracks and keeps the shared capture until the last track stops', async () => {
    platform.getElectronAPI.mockReturnValue({ ...api, platform: 'win32' });
    api.startSystemAudio.mockResolvedValue({ ok: true, pcm: true });
    const first = fakeTrack();
    const second = fakeTrack();
    const tracks = [first.track, second.track];
    processAudio.open.mockImplementation(async (onStop: () => void) => {
      const track = tracks.shift()!;
      const originalStop = track.stop.bind(track);
      track.stop = (): void => { originalStop(); onStop(); };
      return track;
    });

    const [a, b] = await Promise.all([
      acquireAppExcludedSystemAudio(),
      acquireAppExcludedSystemAudio(),
    ]);

    expect(a).toBe(first.track);
    expect(b).toBe(second.track);
    expect(api.startSystemAudio).toHaveBeenCalledOnce();
    expect(processAudio.open).toHaveBeenCalledTimes(2);

    a!.stop();
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
    b!.stop();
    expect(api.stopSystemAudio).toHaveBeenCalledOnce();
  });

  it('takes the source down when the track stops or ends', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const stopped = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], stopped.track);
    const originalStop = stopped.raw.stop;
    const track = await acquireAppExcludedSystemAudio();
    track!.stop();
    expect(originalStop).toHaveBeenCalledTimes(1);
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);

    api.stopSystemAudio.mockClear();
    const ended = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], ended.track);
    await acquireAppExcludedSystemAudio();
    ended.listeners.get('ended')!();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('waits for a source that shows up late', async () => {
    vi.useFakeTimers();
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const { track } = fakeTrack();
    const media = stubMedia([{ kind: 'audioinput', label: 'Default', deviceId: 'default' }], track);
    media.enumerateDevices
      .mockResolvedValueOnce([{ kind: 'audioinput', label: 'Default', deviceId: 'default' }] as MediaDeviceInfo[])
      .mockResolvedValueOnce([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'late' }] as MediaDeviceInfo[]);
    const pending = acquireAppExcludedSystemAudio();
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toBe(track);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('gives up, and unlinks, when the source never appears', async () => {
    vi.useFakeTimers();
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const media = stubMedia([{ kind: 'audioinput', label: 'Default', deviceId: 'default' }], undefined);
    const pending = acquireAppExcludedSystemAudio();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toBeNull();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('unlinks when the device cannot be opened', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const media = stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], undefined);
    media.getUserMedia.mockRejectedValue(new DOMException('busy', 'NotReadableError'));
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('unlinks when the opened stream has no audio track', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], undefined);
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('shares one link between overlapping captures and unlinks with the last one', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const first = fakeTrack();
    const second = fakeTrack();
    const media = stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], first.track);
    const a = await acquireAppExcludedSystemAudio();
    media.getUserMedia.mockResolvedValue({ getAudioTracks: () => [second.track] });
    const b = await acquireAppExcludedSystemAudio();
    expect(api.startSystemAudio).toHaveBeenCalledTimes(1);

    a!.stop();
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
    a!.stop(); // stopping twice is still one release
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
    b!.stop();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('links again for a capture that starts after the last one ended', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const first = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], first.track);
    (await acquireAppExcludedSystemAudio())!.stop();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
    await acquireAppExcludedSystemAudio();
    expect(api.startSystemAudio).toHaveBeenCalledTimes(2);
  });

  it('starts once for two captures that begin together', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const first = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], first.track);
    await Promise.all([acquireAppExcludedSystemAudio(), acquireAppExcludedSystemAudio()]);
    expect(api.startSystemAudio).toHaveBeenCalledTimes(1);
  });
});

describe('isAppSystemAudioSource', () => {
  it('recognises the virtual source and nothing else', () => {
    expect(isAppSystemAudioSource({ kind: 'audioinput', label: 'vencord-screen-share' })).toBe(true);
    expect(isAppSystemAudioSource({ kind: 'audioinput', label: 'Built-in Audio Analog Stereo' })).toBe(false);
    expect(isAppSystemAudioSource({ kind: 'audiooutput', label: 'vencord-screen-share' })).toBe(false);
  });
});

describe('userDevicesSignature', () => {
  const mic = { kind: 'audioinput', deviceId: 'mic-1', groupId: 'g1', label: 'USB Mic' } as MediaDeviceInfo;
  const def = { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: 'Default - USB Mic' } as MediaDeviceInfo;
  const source = {
    kind: 'audioinput', deviceId: 'vs-1', groupId: 'g9', label: 'vencord-screen-share',
  } as MediaDeviceInfo;

  it('does not change when only the share source appears or goes', () => {
    expect(userDevicesSignature([def, mic, source])).toBe(userDevicesSignature([def, mic]));
  });

  it('does not depend on the order of the list', () => {
    expect(userDevicesSignature([mic, def])).toBe(userDevicesSignature([def, mic]));
  });

  it('changes when a device is added or removed', () => {
    const headset = { kind: 'audioinput', deviceId: 'hs-1', groupId: 'g2', label: 'Headset' } as MediaDeviceInfo;
    expect(userDevicesSignature([def, mic, headset])).not.toBe(userDevicesSignature([def, mic]));
  });

  it('changes when the OS default moves to another device, though no deviceId changes', () => {
    // Chromium keeps the `default` entry's id and relabels it; the handler re-acquires on this.
    const movedDefault = { ...def, groupId: 'g2', label: 'Default - Headset' } as MediaDeviceInfo;
    const headset = { kind: 'audioinput', deviceId: 'hs-1', groupId: 'g2', label: 'Headset' } as MediaDeviceInfo;
    expect(userDevicesSignature([movedDefault, mic, headset])).not.toBe(userDevicesSignature([def, mic, headset]));
  });
});
