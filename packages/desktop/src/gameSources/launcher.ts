import { findLauncherGameForProcess, loadLauncherIndex } from '../launcherGames';
import type { SourceDetector } from './types';

export const launcherSourceDetector: SourceDetector = (info) => {
  const game = findLauncherGameForProcess(info, loadLauncherIndex());
  return game ? { id: game.id, name: game.name, type: 'playing' } : null;
};
