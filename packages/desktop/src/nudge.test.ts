import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./nudgeToast', () => ({ showNudgeToast: vi.fn() }));
vi.mock('./desktopScreenshot', () => ({ captureDisplayFrames: vi.fn() }));

// Ensure Wayland is not detected in tests
vi.stubGlobal('process', { ...process, platform: 'linux', env: { ...process.env, XDG_SESSION_TYPE: '', WAYLAND_DISPLAY: '' } });

const mocks = vi.hoisted(() => ({ windows: [] as any[], getSources: vi.fn(), displays: [
  { id: 1, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
  { id: 2, bounds: { x: 0, y: -200, width: 2560, height: 1440 }, size: { width: 2560, height: 1440 }, scaleFactor: 1.5 },
] }));
vi.mock('electron', () => ({
  desktopCapturer: { getSources: mocks.getSources },
  screen: { getAllDisplays: () => mocks.displays, getPrimaryDisplay: () => mocks.displays[1], on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: class {
    options: unknown;
    destroyed = false;
    webContents = { executeJavaScript: vi.fn().mockResolvedValue(undefined) };
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    setFullScreen = vi.fn();
    setOpacity = vi.fn();
    bounds: unknown = {};
    setBounds = vi.fn((b: unknown) => { this.bounds = b; });
    getBounds() { return this.bounds; }
    moveTop = vi.fn();
    showInactive = vi.fn();
    loadURL = vi.fn().mockResolvedValue(undefined);
    constructor(options: unknown) { this.options = options; mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  },
}));

describe('desktop nudge overlays', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.windows.length = 0;
    mocks.getSources.mockImplementation(async () => {
      expect(mocks.windows).toHaveLength(0);
      return mocks.displays.map(d => ({ display_id: String(d.id), thumbnail: {
        isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==',
      } }));
    });
  });
  it('preserves mixed DPI display bounds, synchronizes animations and removes every overlay', async () => {
    const { playNudge } = await import('./nudge');
    await playNudge();
    expect(mocks.getSources).toHaveBeenCalledWith(expect.objectContaining({ thumbnailSize: { width: 3840, height: 2160 } }));
    expect(mocks.windows).toHaveLength(2);
    mocks.windows.forEach((w, i) => {
      expect(w.options).toMatchObject({ ...mocks.displays[i]!.bounds, focusable: false, show: false, opacity: 0, transparent: true, backgroundColor: '#00000000' });
      expect(w.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
      expect(w.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
      expect(w.setBounds).toHaveBeenCalledWith(mocks.displays[i]!.bounds);
      expect(w.setFullScreen).not.toHaveBeenCalled();
      expect(w.setBounds).toHaveBeenLastCalledWith(mocks.displays[i]!.bounds);
      expect(w.showInactive).toHaveBeenCalledOnce();
      expect(w.webContents.executeJavaScript.mock.calls[0][0]).toContain('.decode()');
      expect(w.setOpacity).toHaveBeenCalledWith(1);
      expect(w.setOpacity.mock.invocationCallOrder[0]).toBeGreaterThan(
        Math.max(...mocks.windows.map(other => other.webContents.executeJavaScript.mock.invocationCallOrder[0])),
      );
      expect(w.destroyed).toBe(true);
    });
    expect(mocks.windows[0].webContents.executeJavaScript.mock.calls[1][0])
      .toBe(mocks.windows[1].webContents.executeJavaScript.mock.calls[1][0]);
    await playNudge();
    expect(mocks.windows).toHaveLength(2);
  });
  it('does not display a partial effect if a monitor cannot be captured, and shows the notification instead', async () => {
    mocks.getSources.mockResolvedValue([]);
    const { showNudgeToast } = await import('./nudgeToast');
    const { playNudge } = await import('./nudge');
    await playNudge('Ana');
    expect(showNudgeToast).toHaveBeenCalledWith('Ana', undefined, undefined, 'shake', true, {});
    expect(mocks.windows).toHaveLength(0);
  });
  it('falls back to the notification when screen capture itself fails', async () => {
    mocks.getSources.mockRejectedValue(new Error('Failed to get sources'));
    const { showNudgeToast } = await import('./nudgeToast');
    const { playNudge } = await import('./nudge');
    await playNudge('Ana');
    expect(showNudgeToast).toHaveBeenCalledWith('Ana', undefined, undefined, 'shake', true, {});
    expect(mocks.windows).toHaveLength(0);
  });
  it('animates a silent screenshot instead of desktopCapturer inside a Wayland session', async () => {
    const env = process.env as Record<string, string | undefined>;
    env.WAYLAND_DISPLAY = 'wayland-1';
    mocks.getSources.mockClear();
    try {
      const { captureDisplayFrames } = await import('./desktopScreenshot');
      vi.mocked(captureDisplayFrames).mockResolvedValue(new Map(mocks.displays.map(d => [d.id, 'data:image/png;base64,BB=='])));
      const { playNudge } = await import('./nudge');
      await playNudge('Ana');
      expect(captureDisplayFrames).toHaveBeenCalledOnce();
      expect(mocks.getSources).not.toHaveBeenCalled();
      expect(mocks.windows).toHaveLength(2);
    } finally {
      env.WAYLAND_DISPLAY = '';
    }
  });

  it('shows the notification when the Wayland screenshot is unavailable', async () => {
    const env = process.env as Record<string, string | undefined>;
    env.WAYLAND_DISPLAY = 'wayland-1';
    try {
      const { captureDisplayFrames } = await import('./desktopScreenshot');
      vi.mocked(captureDisplayFrames).mockRejectedValue(new Error('spawn spectacle ENOENT'));
      const { showNudgeToast } = await import('./nudgeToast');
      const { playNudge } = await import('./nudge');
      await playNudge('Ana');
      expect(showNudgeToast).toHaveBeenCalledWith('Ana', undefined, undefined, 'shake', true, {});
      expect(mocks.windows).toHaveLength(0);
    } finally {
      env.WAYLAND_DISPLAY = '';
    }
  });
});
