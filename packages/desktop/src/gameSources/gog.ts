import { findGogGameForProcess, loadGogIndex } from '../gogGames';
import type { SourceDetector } from './types';

export const gogSourceDetector: SourceDetector = (info) => {
  const game = findGogGameForProcess(info.exe, info.cmdline, loadGogIndex());
  return game ? { id: `gog-${game.id}`, name: game.name, type: 'playing' } : null;
};
