import path from 'path';
import { getSteamRoots } from '../../steamGames';
import { firstExistingIcon } from '../files';
import type { GameIcon } from '../types';

export async function steamIcon(appId: number, home: string): Promise<GameIcon | null> {
  for (const root of getSteamRoots(home)) {
    const cache = path.join(root, 'appcache', 'librarycache');
    const icon = await firstExistingIcon([
      path.join(cache, `${appId}_icon.jpg`),
      path.join(cache, `${appId}`, 'library_600x900.jpg'),
      path.join(cache, `${appId}`, 'header.jpg'),
      path.join(cache, `${appId}.jpg`),
    ]);
    if (icon) return icon;
  }
  return null;
}
