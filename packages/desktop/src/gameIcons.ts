/**
 * Public game icon API. Provider-specific extraction and cache/orchestration
 * live under `gameIcons/`; these exports keep existing callers stable.
 */
export {
  execProgramName,
  parseDesktopEntry,
  sniffImageMime,
  type DesktopEntry,
} from './gameIcons/files';
export {
  __testResetGameIconCache,
  findGameIcon,
  getGameIcon,
  resolveGameIcon,
  warmGameIcon,
  warmGameIconForIpc,
} from './gameIcons/resolve';
export type { GameIcon, GameIconTarget } from './gameIcons/types';
