import type { MediaChangeCallback, MediaSetupHintCallback } from './types';
import { startDarwinMedia, stopDarwinMedia } from './darwinMedia';
import { startLinuxMedia, stopLinuxMedia } from './linuxMpris';
import { startWin32Media, stopWin32Media } from './win32Media';

export interface MediaAdapter {
  start(onChange: MediaChangeCallback, onSetupHint?: MediaSetupHintCallback): void;
  stop(): void;
}

export function mediaAdapterFor(
  platform: NodeJS.Platform = process.platform,
): MediaAdapter | null {
  if (platform === 'darwin') {
    return { start: startDarwinMedia, stop: stopDarwinMedia };
  }
  if (platform === 'win32') {
    return { start: startWin32Media, stop: stopWin32Media };
  }
  if (platform === 'linux') {
    return { start: startLinuxMedia, stop: stopLinuxMedia };
  }
  return null;
}
