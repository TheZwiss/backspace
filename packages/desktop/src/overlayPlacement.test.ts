import { describe, expect, it, vi } from 'vitest';
import { coverDisplay, settleOverlayBounds } from './overlayPlacement';

const bounds = { x: 1920, y: 91, width: 1920, height: 1080 };
const fakeWindow = (destroyed = false) => ({ setBounds: vi.fn(), setFullScreen: vi.fn(), isDestroyed: () => destroyed }) as never as import('electron').BrowserWindow & { setBounds: ReturnType<typeof vi.fn>; setFullScreen: ReturnType<typeof vi.fn> };

describe('overlay placement', () => {
  it('goes fullscreen on Windows and macOS to cover the taskbar', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const w = fakeWindow();
      coverDisplay(w, bounds, platform);
      expect(w.setBounds).toHaveBeenCalledWith(bounds);
      expect(w.setFullScreen).toHaveBeenCalledWith(true);
    }
  });

  it('never goes fullscreen on Linux, where the window comes back oversized', () => {
    const w = fakeWindow();
    coverDisplay(w, bounds, 'linux');
    expect(w.setFullScreen).not.toHaveBeenCalled();
  });

  it('applies the bounds, waits, and applies them again, only on Linux', async () => {
    const linux = fakeWindow();
    await settleOverlayBounds(linux, bounds, 'linux', 0);
    expect(linux.setBounds).toHaveBeenCalledTimes(2);
    expect(linux.setBounds).toHaveBeenCalledWith(bounds);
    const windows = fakeWindow();
    await settleOverlayBounds(windows, bounds, 'win32', 0);
    expect(windows.setBounds).not.toHaveBeenCalled();
  });

  it('skips a destroyed window, including one destroyed while waiting', async () => {
    const gone = fakeWindow(true);
    await settleOverlayBounds(gone, bounds, 'linux', 0);
    expect(gone.setBounds).not.toHaveBeenCalled();
    let destroyed = false;
    const closing = fakeWindow();
    closing.isDestroyed = () => destroyed;
    const pending = settleOverlayBounds(closing, bounds, 'linux', 5);
    destroyed = true;
    await pending;
    expect(closing.setBounds).toHaveBeenCalledTimes(1);
  });
});
