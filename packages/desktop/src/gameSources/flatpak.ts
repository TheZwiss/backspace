import { findFlatpakGameForProcess, loadFlatpakIndex } from '../flatpakGames';
import type { SourceDetector } from './types';

export const flatpakSourceDetector: SourceDetector = (info) => {
  const game = findFlatpakGameForProcess(info.exe, loadFlatpakIndex());
  return game ? { id: `flatpak-${game.appId}`, name: game.name, type: 'playing' } : null;
};
