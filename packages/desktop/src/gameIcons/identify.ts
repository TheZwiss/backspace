import { findSteamGameForProcess, getSteamRoots, loadSteamIndex } from '../steamGames';
import { findFlatpakGameForProcess, getFlatpakInstallDirs, loadFlatpakIndex } from '../flatpakGames';
import { findGogGameForProcess, loadGogIndex } from '../gogGames';
import { findLauncherGameForProcess, loadLauncherIndex } from '../launcherGames';
import type { GameIconTarget } from './types';

const STORE_ID = /^(steam|flatpak|gog|heroic|bottles|lutris)-/;

export function installedGameId(target: GameIconTarget, home: string): string | null {
  if (STORE_ID.test(target.id)) return null;
  const steam = loadSteamIndex(getSteamRoots(home), true);
  const flatpak = loadFlatpakIndex(getFlatpakInstallDirs(home), true);
  const gog = loadGogIndex(home, true);

  if (target.exe) {
    const bySteam = findSteamGameForProcess(target.exe, steam);
    if (bySteam) return `steam-${bySteam.appId}`;
    const byFlatpak = findFlatpakGameForProcess(target.exe, flatpak);
    if (byFlatpak) return `flatpak-${byFlatpak.appId}`;
    const byGog = findGogGameForProcess(target.exe, target.cmdline, gog);
    if (byGog) return `gog-${byGog.id}`;
  }
  const launcher = loadLauncherIndex(home, true);
  const byLauncher = findLauncherGameForProcess(
    { exe: target.exe, cmdline: target.cmdline, winExes: target.winExes, cwd: target.cwd ?? undefined },
    launcher,
  );
  if (byLauncher) return byLauncher.id;

  const name = target.name.trim().toLowerCase();
  if (name === '') return null;
  const sameName = (candidate: string) => candidate.trim().toLowerCase() === name;
  const bySteamName = steam.find((game) => sameName(game.name));
  if (bySteamName) return `steam-${bySteamName.appId}`;
  const byFlatpakName = flatpak.find((game) => sameName(game.name));
  if (byFlatpakName) return `flatpak-${byFlatpakName.appId}`;
  const byGogName = gog.find((game) => sameName(game.name));
  if (byGogName) return `gog-${byGogName.id}`;
  const byLauncherName = launcher.find((game) => sameName(game.name));
  if (byLauncherName) return byLauncherName.id;
  return null;
}
