import { loadLauncherIndex } from '../../launcherGames';
import { firstExistingIcon } from '../files';
import type { GameIcon } from '../types';

export async function launcherIcon(id: string, home: string): Promise<GameIcon | null> {
  const game = loadLauncherIndex(home).find((candidate) => candidate.id === id);
  return game?.iconPath ? firstExistingIcon([game.iconPath]) : null;
}
