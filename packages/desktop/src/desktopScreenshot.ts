import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { nativeImage, type Display } from 'electron';

export interface FrameRegion { x: number; y: number; width: number; height: number }

/**
 * Silent screenshot for Wayland sessions, where desktopCapturer either opens the
 * screencast picker or (under XWayland) captures only black. KDE's `spectacle`
 * ships with Plasma and takes a background screenshot of every monitor in one
 * image without any dialog.
 */
const SPECTACLE_TIMEOUT_MS = 8000;

/** Pixel region of one display inside a single image that spans the whole virtual desktop. */
export function regionForDisplay(display: Display, displays: Display[], imageWidth: number): FrameRegion {
  const minX = Math.min(...displays.map(d => d.bounds.x));
  const minY = Math.min(...displays.map(d => d.bounds.y));
  const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
  const scale = imageWidth / (maxX - minX);
  return {
    x: Math.round((display.bounds.x - minX) * scale),
    y: Math.round((display.bounds.y - minY) * scale),
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale),
  };
}

function runSpectacle(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('spectacle', ['--background', '--nonotify', '--fullscreen', '--output', file], { timeout: SPECTACLE_TIMEOUT_MS }, error => error ? reject(error) : resolve());
  });
}

/** Display id -> PNG data URL of that display, taken before any overlay exists. */
export async function captureDisplayFrames(displays: Display[]): Promise<Map<number, string>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'backspace-nudge-'));
  try {
    const file = path.join(dir, 'desktop.png');
    await runSpectacle(file);
    const image = nativeImage.createFromBuffer(await readFile(file));
    if (image.isEmpty()) throw new Error('Display capture unavailable');
    const { width, height } = image.getSize();
    const frames = new Map<number, string>();
    for (const display of displays) {
      const region = regionForDisplay(display, displays, width);
      if (region.x + region.width > width || region.y + region.height > height) throw new Error('Display capture unavailable');
      frames.set(display.id, image.crop(region).toDataURL());
    }
    return frames;
  } finally {
    // The screenshot is private; never leave it behind.
    await rm(dir, { recursive: true, force: true });
  }
}
