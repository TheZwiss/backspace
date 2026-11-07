import type { BrowserWindow, Rectangle } from 'electron';

/**
 * Full-display overlays. Windows needs setFullScreen to cover the taskbar. On Linux
 * (KWin through XWayland) the same call hands back a window larger than the display
 * (1952x1122 on a 1920x1080 monitor), which stretches whatever the overlay draws, so
 * Linux asks for the exact bounds once the window is mapped instead.
 */
export function coverDisplay(window: BrowserWindow, bounds: Rectangle, platform: NodeJS.Platform = process.platform): void {
  window.setBounds(bounds);
  if (platform !== 'linux') window.setFullScreen(true);
}

const SETTLE_MS = 150;

/**
 * Applies the display bounds once the window is shown (the window manager ignores them
 * before), gives it time to resize, and applies them again. Electron reports the bounds
 * it asked for as soon as setBounds returns, so waiting on getBounds proves nothing.
 * The overlay is still transparent here; painting starts only afterwards, so a late
 * resize cannot show up as a one-frame flash.
 */
export async function settleOverlayBounds(window: BrowserWindow, bounds: Rectangle, platform: NodeJS.Platform = process.platform, delayMs = SETTLE_MS): Promise<void> {
  if (platform !== 'linux' || window.isDestroyed()) return;
  window.setBounds(bounds);
  await new Promise(resolve => setTimeout(resolve, delayMs));
  if (!window.isDestroyed()) window.setBounds(bounds);
}
