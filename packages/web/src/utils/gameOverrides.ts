import type { Activity } from '@backspace/shared';
import { ACTIVITY_LIMITS } from '@backspace/shared/src/activities';

/**
 * What the player decided about the games they are shown as playing.
 *
 * - `manualGames`: games the player added themselves ("Created manually").
 *   One tied to a program (`process`, desktop only) is shown while that program
 *   runs: the detector builds the activity, this client only tells it which
 *   programs to watch. One without a program (a browser has no processes) is
 *   shown until the player removes it.
 * - `hidden`: games (by name key) the player does not want shown. They are
 *   still detected, just not sent.
 * - `order`: the priority order of games (name keys). The first one shown is
 *   what lists and the profile popout lead with.
 * - `renames`: for a game the detector DID find, the name the player wants
 *   shown instead (detected name, lowercased → chosen name), remembered.
 *
 * All of it lives in this browser's storage only: it is a presentation choice
 * of this client, and the server and federation see ordinary activities.
 */
export interface ManualGame {
  name: string;
  /** The program the game follows (desktop), or null for a game shown by name alone. */
  process: string | null;
}

export interface GameOverrides {
  manualGames: ManualGame[];
  hidden: string[];
  order: string[];
  renames: Record<string, string>;
}

export const GAME_OVERRIDES_KEY = 'backspace_game_overrides';

/** More renames than any library holds; the oldest is dropped past this. */
export const MAX_GAME_RENAMES = 200;
/** Games a player can add by hand. */
export const MAX_MANUAL_GAMES = 30;
/** Bound on the remembered hidden and order lists. */
export const MAX_GAME_LIST = 200;

/** Collapse whitespace, drop control characters, cap at the activity name limit. Null when nothing is left. */
export function sanitizeGameName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  return cleaned.slice(0, ACTIVITY_LIMITS.MAX_NAME_LENGTH).trim();
}

/** A program name as the desktop reports it: trimmed, no control characters, bounded. Null when empty. */
export function sanitizeProcessName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' ? null : cleaned.slice(0, 256);
}

/** The key a game name is remembered under (renames, hidden, order). */
export function renameKey(detectedName: string): string {
  return detectedName.trim().toLowerCase();
}

export const gameKey = renameKey;

export function emptyOverrides(): GameOverrides {
  return { manualGames: [], hidden: [], order: [], renames: {} };
}

function keyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = renameKey(item);
    if (key !== '' && !keys.includes(key)) keys.push(key);
  }
  return keys.slice(0, MAX_GAME_LIST);
}

function manualList(value: unknown): ManualGame[] {
  if (!Array.isArray(value)) return [];
  const games: ManualGame[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { name, process } = item as Record<string, unknown>;
    const cleanName = typeof name === 'string' ? sanitizeGameName(name) : null;
    if (!cleanName) continue;
    const cleanProcess = typeof process === 'string' ? sanitizeProcessName(process) : null;
    games.push({ name: cleanName, process: cleanProcess });
  }
  return dedupeManual(games).slice(0, MAX_MANUAL_GAMES);
}

function dedupeManual(games: ManualGame[]): ManualGame[] {
  const seen = new Set<string>();
  return games.filter((game) => {
    const key = renameKey(game.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function loadOverrides(): GameOverrides {
  try {
    const raw = localStorage.getItem(GAME_OVERRIDES_KEY);
    if (!raw) return emptyOverrides();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyOverrides();
    const { manualGames, manual, manualProcess, hidden, order, renames } = parsed as Record<string, unknown>;

    const result = emptyOverrides();
    result.manualGames = manualList(manualGames);
    // Before the list existed there was one manual game, with or without a program
    if (result.manualGames.length === 0 && typeof manual === 'string') {
      const name = sanitizeGameName(manual);
      if (name) {
        result.manualGames = [{ name, process: typeof manualProcess === 'string' ? sanitizeProcessName(manualProcess) : null }];
      }
    }
    result.hidden = keyList(hidden);
    result.order = keyList(order);
    if (renames && typeof renames === 'object') {
      for (const [key, value] of Object.entries(renames as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        const name = sanitizeGameName(value);
        if (name && key !== '') result.renames[key] = name;
      }
    }
    return result;
  } catch {
    return emptyOverrides();
  }
}

export function saveOverrides(overrides: GameOverrides): void {
  try {
    if (
      overrides.manualGames.length === 0
      && overrides.hidden.length === 0
      && overrides.order.length === 0
      && Object.keys(overrides.renames).length === 0
    ) {
      localStorage.removeItem(GAME_OVERRIDES_KEY);
      return;
    }
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // Storage unavailable: the choice lasts for this session only
  }
}

export function clearOverrides(): void {
  try {
    localStorage.removeItem(GAME_OVERRIDES_KEY);
  } catch {
    // Nothing stored to clear
  }
}

// ─── Manual games ───────────────────────────────────────────────────────────

/** Add a manual game, or replace the one with the same name. Returns the list unchanged for a blank name. */
export function addManualGame(games: ManualGame[], name: string, process: string | null): ManualGame[] {
  const cleanName = sanitizeGameName(name);
  if (!cleanName) return games;
  const cleanProcess = process === null ? null : sanitizeProcessName(process);
  const key = renameKey(cleanName);
  const next = games.filter((game) => renameKey(game.name) !== key);
  next.push({ name: cleanName, process: cleanProcess });
  return next.slice(-MAX_MANUAL_GAMES);
}

/**
 * Give a manual game another name, keeping its program and its place in the
 * list. Null when nothing changes: a blank name, the same name, or a name
 * another manual game already has.
 */
export function renameManualGame(games: ManualGame[], from: string, to: string): ManualGame[] | null {
  const name = sanitizeGameName(to);
  const fromKey = renameKey(from);
  if (!name || !games.some((game) => renameKey(game.name) === fromKey)) return null;
  const toKey = renameKey(name);
  if (toKey !== fromKey && games.some((game) => renameKey(game.name) === toKey)) return null;
  if (games.some((game) => renameKey(game.name) === fromKey && game.name === name)) return null;
  return games.map((game) => (renameKey(game.name) === fromKey ? { ...game, name } : game));
}

/** Follow a renamed game in a list of name keys (hidden, order). */
export function renameKeyIn(keys: string[], from: string, to: string): string[] {
  const fromKey = renameKey(from);
  const toKey = renameKey(to);
  if (fromKey === toKey || !keys.includes(fromKey)) return keys;
  const moved = keys.map((key) => (key === fromKey ? toKey : key));
  return moved.filter((key, i) => moved.indexOf(key) === i);
}

export function removeManualGame(games: ManualGame[], name: string): ManualGame[] {
  const key = renameKey(name);
  return games.filter((game) => renameKey(game.name) !== key);
}

/** The manual games the desktop must watch a program for. */
export function boundGames(games: ManualGame[]): Array<{ name: string; process: string }> {
  const bound: Array<{ name: string; process: string }> = [];
  for (const game of games) {
    if (game.process !== null) bound.push({ name: game.name, process: game.process });
  }
  return bound;
}

// ─── Applying the choices ───────────────────────────────────────────────────

/**
 * Add the games the player named without a program. Other activity types
 * (music, video) are untouched, and a game already detected under that name is
 * not listed twice. The input is returned as is when there is nothing to add.
 */
export function withManualGames(detected: Activity[], manualGames: ManualGame[]): Activity[] {
  const present = new Set(detected.filter((a) => a.type === 'playing').map((a) => renameKey(a.name)));
  const added: Activity[] = [];
  for (const game of manualGames) {
    if (game.process !== null || present.has(renameKey(game.name))) continue;
    added.push({ type: 'playing', name: game.name });
  }
  return added.length === 0 ? detected : [...added, ...detected];
}

/** Leave out the games the player hides. */
export function withoutHidden(activities: Activity[], hidden: string[]): Activity[] {
  if (hidden.length === 0) return activities;
  const kept = activities.filter((a) => a.type !== 'playing' || !hidden.includes(renameKey(a.name)));
  return kept.length === activities.length ? activities : kept;
}

/**
 * Put the games in the player's priority order. Only the "playing" entries
 * move, among the places playing entries already hold; a game the order does
 * not list comes after the listed ones, in the order it came.
 */
export function withOrder(activities: Activity[], order: string[]): Activity[] {
  if (order.length === 0) return activities;
  const rank = (a: Activity) => {
    const at = order.indexOf(renameKey(a.name));
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const games = activities.filter((a) => a.type === 'playing');
  const sorted = [...games].sort((a, b) => rank(a) - rank(b)); // stable
  if (sorted.every((game, i) => game === games[i])) return activities;
  let next = 0;
  return activities.map((a) => (a.type === 'playing' ? (sorted[next++] as Activity) : a));
}

/** Keys of `known` in the player's order, then the rest as given. */
export function orderedKeys(known: string[], order: string[]): string[] {
  const listed = order.filter((key) => known.includes(key));
  return [...listed, ...known.filter((key) => !listed.includes(key))];
}

/** Move `key` one place up or down in `keys`; the list unchanged at either end. */
export function moveKey(keys: string[], key: string, direction: -1 | 1): string[] {
  const at = keys.indexOf(key);
  const to = at + direction;
  if (at === -1 || to < 0 || to >= keys.length) return keys;
  const next = [...keys];
  [next[at], next[to]] = [next[to] as string, next[at] as string];
  return next;
}

/** Move `key` to where `target` is, the others shifting along: what dropping a dragged row on another does. */
export function moveKeyTo(keys: string[], key: string, target: string): string[] {
  const from = keys.indexOf(key);
  const to = keys.indexOf(target);
  if (from === -1 || to === -1 || from === to) return keys;
  const next = keys.filter((k) => k !== key);
  next.splice(to, 0, key);
  return next;
}

/** Hide or show a game. */
export function setHidden(hidden: string[], name: string, hide: boolean): string[] {
  const key = renameKey(name);
  const without = hidden.filter((k) => k !== key);
  if (!hide || key === '') return without;
  return [...without, key].slice(-MAX_GAME_LIST);
}

/**
 * Show a detected game under the name the player chose for it. Everything
 * else about the activity (details, timestamps, art) is kept. Applied last, so
 * the icon lookup above it still goes by the name the machine knows the game by.
 */
export function withRenames(activities: Activity[], renames: Record<string, string>): Activity[] {
  if (Object.keys(renames).length === 0) return activities;
  let changed = false;
  const result = activities.map((activity) => {
    if (activity.type !== 'playing') return activity;
    const chosen = renames[renameKey(activity.name)];
    if (!chosen || chosen === activity.name) return activity;
    changed = true;
    return { ...activity, name: chosen };
  });
  return changed ? result : activities;
}

/** Add or replace a rename, dropping the oldest past the cap. An empty or unchanged name removes it. */
export function setRename(
  renames: Record<string, string>,
  detectedName: string,
  chosen: string | null,
): Record<string, string> {
  const key = renameKey(detectedName);
  const name = chosen === null ? null : sanitizeGameName(chosen);
  const next = { ...renames };
  delete next[key];
  if (key === '' || name === null || name === detectedName.trim()) return next;
  next[key] = name; // re-inserted last, so insertion order is age order
  const keys = Object.keys(next);
  for (const oldest of keys.slice(0, Math.max(0, keys.length - MAX_GAME_RENAMES))) {
    delete next[oldest];
  }
  return next;
}
