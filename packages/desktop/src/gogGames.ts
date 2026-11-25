import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Local GOG game source.
 *
 * The GOG Linux installer creates ~/GOG Games/<Game Dir>/ containing a
 * goggame-<id>.info JSON with the display name, and the game runs from that
 * directory. Matching is by exe path under the game dir, with a command-line
 * fallback for launchers whose exe escapes /proc (start.sh wrappers).
 */

export interface GogGame {
  /** goggame-<gameId>.info id, or the directory name when the info is unreadable */
  id: string;
  name: string;
  /** Absolute path of ~/GOG Games/<dir> */
  dir: string;
}

const INDEX_TTL_MS = 60_000;

let indexCache: { at: number; games: GogGame[] } | null = null;

/** Parse a goggame-*.info body: {"name": "..."} or an array of such objects. */
export function parseGogInfo(text: string): { name: string | null; gameId: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { name: null, gameId: null };
  }

  const record = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  if (!record || typeof record !== 'object') {
    return { name: null, gameId: null };
  }

  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null;
  const gameId = typeof record.gameId === 'string' && record.gameId.trim() ? record.gameId.trim() : null;
  return { name, gameId };
}

/** The GOG Games root (injectable for tests). */
export function getGogGamesDir(home: string = os.homedir()): string {
  return path.join(home, 'GOG Games');
}

function readGames(gamesRoot: string): GogGame[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(gamesRoot);
  } catch {
    return [];
  }

  const games: GogGame[] = [];
  for (const dir of dirs) {
    const gameDir = path.join(gamesRoot, dir);
    try {
      if (!fs.statSync(gameDir).isDirectory()) continue;
    } catch {
      continue;
    }

    // Name from goggame-*.info, falling back to the directory name
    let name = dir;
    let id = dir;
    try {
      const infoFile = fs.readdirSync(gameDir).find((f) => /^goggame-.*\.info$/.test(f));
      if (infoFile) {
        const info = parseGogInfo(fs.readFileSync(path.join(gameDir, infoFile), 'utf-8'));
        if (info.name) name = info.name;
        if (info.gameId) id = info.gameId;
      }
    } catch {
      // Unreadable info — directory-name fallback already applies
    }

    games.push({ id, name, dir: gameDir });
  }
  return games;
}

/** Drop the index cache (test hook). */
export function resetGogIndexCache(): void {
  indexCache = null;
}

/** All installed GOG games, cached for 60 seconds. force=true bypasses. */
export function loadGogIndex(home: string = os.homedir(), force = false): GogGame[] {
  if (!force && indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return indexCache.games;
  }

  const games = readGames(getGogGamesDir(home));
  indexCache = { at: Date.now(), games };
  return games;
}

function isUnder(target: string, dir: string): boolean {
  const t = target.toLowerCase();
  const d = dir.toLowerCase();
  return d.length > 0 && (t === d || t.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
}

/**
 * The GOG game the running process belongs to: exe path under the game
 * directory, or the directory appearing in the command line (start.sh
 * wrappers whose exe is the shell).
 */
export function findGogGameForProcess(exe: string | null, cmdline: string, games: GogGame[]): GogGame | null {
  if (exe) {
    for (const game of games) {
      if (isUnder(exe, game.dir)) return game;
    }
  }
  if (cmdline) {
    const lower = cmdline.toLowerCase();
    for (const game of games) {
      if (lower.includes(game.dir.toLowerCase())) return game;
    }
  }
  return null;
}
