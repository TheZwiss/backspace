import path from 'path';
import { loadGogIndex } from '../../gogGames';
import { firstExistingIcon } from '../files';
import type { GameIcon } from '../types';

export async function gogIcon(gameId: string, home: string): Promise<GameIcon | null> {
  for (const game of loadGogIndex(home)) {
    if (game.id !== gameId) continue;
    return firstExistingIcon([
      path.join(game.dir, 'support', 'icon.png'),
      path.join(game.dir, 'support', 'icon_256.png'),
      path.join(game.dir, 'support', 'icon_512.png'),
    ]);
  }
  return null;
}
