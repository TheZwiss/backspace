import { flatpakSourceDetector } from './flatpak';
import { gogSourceDetector } from './gog';
import { launcherSourceDetector } from './launcher';
import { steamSourceDetector } from './steam';
import type { SourceDetector } from './types';

export type { GameSourceProcess, MatchedGame, SourceDetector } from './types';
export { createSteamSourceDetector, findInstalledSteamGame, steamSourceDetector } from './steam';
export { flatpakSourceDetector } from './flatpak';
export { gogSourceDetector } from './gog';
export { launcherSourceDetector } from './launcher';

/** Source order is user-visible priority when a process matches more than one. */
export const defaultGameSourceDetectors: readonly SourceDetector[] = [
  steamSourceDetector,
  flatpakSourceDetector,
  gogSourceDetector,
  launcherSourceDetector,
];
