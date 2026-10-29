import {
  findSteamGameForLaunch,
  findSteamGameForProcess,
  loadSteamIndex,
  type SteamGame,
} from '../steamGames';
import type { GameSourceProcess, SourceDetector } from './types';

function normalize(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/**
 * The launch command covers Proton/Supervisor processes. Executable paths
 * cover native installs on every platform; a case-normalized command-line
 * fallback handles Windows query differences and macOS paths with spaces.
 */
export function findInstalledSteamGame(
  info: GameSourceProcess,
  games: SteamGame[],
): SteamGame | null {
  const direct = findSteamGameForLaunch(info.cmdline, games) ?? findSteamGameForProcess(info.exe, games);
  if (direct) return direct;
  const command = normalize(info.cmdline);
  return games.find((game) => command.includes(normalize(game.installDir))) ?? null;
}

export function createSteamSourceDetector(
  loadGames: () => SteamGame[] = () => loadSteamIndex(),
): SourceDetector {
  return (info) => {
    const game = findInstalledSteamGame(info, loadGames());
    return game ? { id: `steam-${game.appId}`, name: game.name, type: 'playing' } : null;
  };
}

export const steamSourceDetector = createSteamSourceDetector();
