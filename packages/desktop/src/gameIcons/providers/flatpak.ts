import path from 'path';
import { getFlatpakInstallDirs, loadFlatpakIndex } from '../../flatpakGames';
import { HICOLOR_SIZE_DIRS, firstExistingIcon } from '../files';
import type { GameIcon } from '../types';

function flatpakIconCandidates(appId: string, installDirs: string[], home: string): string[] {
  const dirs = [...installDirs, path.join(home, '.local', 'share', 'flatpak')];
  const candidates: string[] = [];
  for (const dir of dirs) {
    const exported = path.join(dir, 'exports', 'share', 'icons', 'hicolor');
    for (const size of HICOLOR_SIZE_DIRS) {
      candidates.push(path.join(exported, size, 'apps', `${appId}.png`));
    }
  }
  return candidates;
}

export async function flatpakIcon(appId: string, home: string): Promise<GameIcon | null> {
  for (const game of loadFlatpakIndex()) {
    if (game.appId !== appId) continue;
    const appExport = path.resolve(game.filesDir, '..', '..', 'export', 'share', 'icons', 'hicolor');
    const icon = await firstExistingIcon(
      HICOLOR_SIZE_DIRS.map((size) => path.join(appExport, size, 'apps', `${appId}.png`)),
    );
    if (icon) return icon;
  }
  return firstExistingIcon(flatpakIconCandidates(appId, getFlatpakInstallDirs(), home));
}
