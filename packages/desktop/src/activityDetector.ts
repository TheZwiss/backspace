import { execFile } from 'child_process';
import https from 'https';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

// ─── Local Activity type (structural match with @backspace/shared Activity) ─

interface ActivityTimestamps {
  start?: number;
  end?: number;
}

interface Activity {
  type: string;
  name: string;
  details?: string;
  state?: string;
  timestamps?: ActivityTimestamps;
}

// ─── Game dictionary types ──────────────────────────────────────────────────

interface GameEntry {
  id: string;
  name: string;
  processes: string[];
  type?: string;
}

interface VersionedDictionary {
  version: number;
  games: GameEntry[];
}

const VALID_TYPES = new Set(['playing', 'listening', 'watching', 'streaming']);
const POLL_INTERVAL_MS = 15_000;
const REMOTE_URL = 'https://raw.githubusercontent.com/TheZwiss/backspace/main/packages/desktop/resources/games.json';

// ─── Module state ───────────────────────────────────────────────────────────

let processMap: Map<string, GameEntry> = new Map();
let gameEntries: GameEntry[] = [];
let currentGameId: string | null = null;
let currentActivity: Activity | null = null;
let intervalId: NodeJS.Timeout | null = null;
let isPolling = false;
let hasErrored = false;
let onChangeCallback: ((activity: Activity | null) => void) | null = null;

// ─── Dictionary loading ────────────────────────────────────────────────────

/**
 * Parse and validate a game entry from the dictionary.
 * Returns a valid GameEntry or null if the entry is malformed.
 */
function parseGameEntry(entry: unknown): GameEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;

  if (typeof e.id !== 'string' || !e.id || typeof e.name !== 'string' || !e.name ||
      !Array.isArray(e.processes) || e.processes.length === 0 ||
      !e.processes.every((p: unknown) => typeof p === 'string')) {
    return null;
  }

  const type = typeof e.type === 'string' && VALID_TYPES.has(e.type) ? e.type : 'playing';

  return {
    id: e.id,
    name: e.name,
    processes: e.processes as string[],
    type,
  };
}

/**
 * Load a game dictionary from a file path.
 * Supports both formats:
 *   - Bare array (legacy, version 0): [{ id, name, processes }, ...]
 *   - Versioned object: { version: number, games: [...] }
 *
 * On success, populates `gameEntries` and `processMap` and returns the version.
 * On failure, returns { success: false, version: 0 } without modifying state.
 */
function loadDictionary(filePath: string): { success: boolean; version: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    console.warn('[ActivityDetector] Dictionary not found at', filePath);
    return { success: false, version: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[ActivityDetector] Dictionary contains malformed JSON at', filePath);
    return { success: false, version: 0 };
  }

  // Determine format: bare array (version 0) vs versioned object
  let version = 0;
  let entries: unknown[];

  if (Array.isArray(parsed)) {
    // Legacy bare-array format
    version = 0;
    entries = parsed;
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.version === 'number' && Array.isArray(obj.games)) {
      version = obj.version;
      entries = obj.games;
    } else {
      console.warn('[ActivityDetector] Dictionary has unknown structure at', filePath);
      return { success: false, version: 0 };
    }
  } else {
    console.warn('[ActivityDetector] Dictionary root must be an array or versioned object at', filePath);
    return { success: false, version: 0 };
  }

  const newEntries: GameEntry[] = [];
  const newMap = new Map<string, GameEntry>();

  for (const entry of entries) {
    const gameEntry = parseGameEntry(entry);
    if (!gameEntry) {
      const e = entry as Record<string, unknown> | null;
      console.warn('[ActivityDetector] Skipping invalid entry:', e?.id ?? JSON.stringify(entry));
      continue;
    }

    newEntries.push(gameEntry);

    for (const proc of gameEntry.processes) {
      const key = proc.toLowerCase();
      if (!newMap.has(key)) {
        newMap.set(key, gameEntry);
      }
    }
  }

  if (newMap.size === 0) {
    console.warn('[ActivityDetector] No valid entries in dictionary at', filePath);
    return { success: false, version: 0 };
  }

  // Commit to module state
  gameEntries = newEntries;
  processMap = newMap;

  console.log(`[ActivityDetector] Loaded ${newEntries.length} games (${newMap.size} process names) v${version} from ${filePath}`);
  return { success: true, version };
}

/**
 * Hot-swap the process map and game entries without resetting detection state.
 * Used when a remote dictionary update is fetched in the background.
 */
function hotSwapDictionary(newEntries: GameEntry[], newMap: Map<string, GameEntry>): void {
  gameEntries = newEntries;
  processMap = newMap;
  // Note: currentGameId and currentActivity are intentionally preserved
  // so detection state survives dictionary updates.
}

// ─── Remote sync ────────────────────────────────────────────────────────────

function getCachePath(): string {
  return path.join(app.getPath('userData'), 'games-cache.json');
}

function getETagPath(): string {
  return path.join(app.getPath('userData'), 'games-cache-etag.txt');
}

function readETag(): string | null {
  try {
    return fs.readFileSync(getETagPath(), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function writeETag(etag: string): void {
  try {
    fs.writeFileSync(getETagPath(), etag, 'utf-8');
  } catch {
    // Non-critical — next sync will just re-download
  }
}

/**
 * Validate a parsed dictionary object without loading it into module state.
 * Returns the validated entries and map, or null if invalid.
 */
function validateDictionary(parsed: unknown): {
  version: number;
  entries: GameEntry[];
  map: Map<string, GameEntry>;
} | null {
  let version = 0;
  let rawEntries: unknown[];

  if (Array.isArray(parsed)) {
    version = 0;
    rawEntries = parsed;
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.version === 'number' && Array.isArray(obj.games)) {
      version = obj.version;
      rawEntries = obj.games;
    } else {
      return null;
    }
  } else {
    return null;
  }

  const entries: GameEntry[] = [];
  const map = new Map<string, GameEntry>();

  for (const entry of rawEntries) {
    const gameEntry = parseGameEntry(entry);
    if (!gameEntry) continue;
    entries.push(gameEntry);
    for (const proc of gameEntry.processes) {
      const key = proc.toLowerCase();
      if (!map.has(key)) {
        map.set(key, gameEntry);
      }
    }
  }

  if (map.size === 0) return null;

  return { version, entries, map };
}

/**
 * Fetch a URL over HTTPS and return the response body and headers.
 * Supports conditional requests via If-None-Match.
 */
function fetchRemote(url: string, etag: string | null): Promise<{
  status: number;
  body: string;
  etag: string | null;
} | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      'User-Agent': 'Backspace-Desktop/1.0',
    };
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    const req = https.get(url, { headers, timeout: 10_000 }, (res) => {
      if (res.statusCode === 304) {
        resolve({ status: 304, body: '', etag: null });
        res.resume(); // Drain the response
        return;
      }

      // Follow single redirect (GitHub raw may 301/302)
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        fetchRemote(res.headers.location, etag).then(resolve).catch(() => resolve(null));
        return;
      }

      if (res.statusCode !== 200) {
        resolve(null);
        res.resume();
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const responseEtag = typeof res.headers.etag === 'string' ? res.headers.etag : null;
        resolve({ status: 200, body, etag: responseEtag });
      });
      res.on('error', () => resolve(null));
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Atomically write data to a file by writing to a .tmp file first,
 * then renaming it into place.
 */
function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Sync the game dictionary from a remote source.
 *
 * Strategy:
 * 1. Load the best local source (cache file or bundled seed), whichever has a higher version.
 * 2. Fetch from GitHub in the background.
 * 3. If the remote version is newer, atomically write to cache, save ETag, and hot-swap.
 */
async function syncDictionary(): Promise<void> {
  const cachePath = getCachePath();
  const seedPath = path.join(__dirname, '..', 'resources', 'games.json');

  // Step 1: Determine best local version (cache vs. seed)
  // The seed was already loaded by startActivityDetection before calling us,
  // but the cache might have a higher version.
  const cacheResult = loadDictionary(cachePath);
  let currentVersion = cacheResult.success ? cacheResult.version : 0;

  if (!cacheResult.success) {
    // Cache missing or corrupt — seed was already loaded, read its version
    const seedResult = loadDictionary(seedPath);
    currentVersion = seedResult.success ? seedResult.version : 0;
  }

  // Step 2: Fetch remote
  const etag = readETag();

  let response: { status: number; body: string; etag: string | null } | null;
  try {
    response = await fetchRemote(REMOTE_URL, etag);
  } catch {
    console.log('[ActivityDetector] Remote sync fetch failed — continuing with local dictionary');
    return;
  }

  if (!response) {
    console.log('[ActivityDetector] Remote sync failed (network error) — continuing with local dictionary');
    return;
  }

  // Step 3: Handle response
  if (response.status === 304) {
    console.log('[ActivityDetector] Remote dictionary unchanged (304)');
    return;
  }

  if (response.status !== 200) {
    console.log(`[ActivityDetector] Remote sync returned status ${response.status} — skipping`);
    return;
  }

  // Parse and validate the remote dictionary
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    console.warn('[ActivityDetector] Remote dictionary contains malformed JSON — skipping');
    return;
  }

  const validated = validateDictionary(parsed);
  if (!validated) {
    console.warn('[ActivityDetector] Remote dictionary validation failed — skipping');
    return;
  }

  // Only apply if version is newer
  if (validated.version <= currentVersion) {
    console.log(`[ActivityDetector] Remote version (${validated.version}) is not newer than local (${currentVersion}) — skipping`);
    // Still save ETag so we get 304 next time
    if (response.etag) {
      writeETag(response.etag);
    }
    return;
  }

  // Atomic write the cache
  try {
    atomicWrite(cachePath, response.body);
  } catch (err) {
    console.warn('[ActivityDetector] Failed to write cache:', err);
    // Non-fatal — we can still hot-swap in memory
  }

  // Save ETag
  if (response.etag) {
    writeETag(response.etag);
  }

  // Hot-swap: rebuild processMap and gameEntries from validated data
  hotSwapDictionary(validated.entries, validated.map);
  console.log(`[ActivityDetector] Hot-swapped to remote dictionary v${validated.version} (${validated.entries.length} games, ${validated.map.size} process names)`);
}

// ─── Platform-specific process listing ──────────────────────────────────────

function getProcessCommand(): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    return { executable: 'tasklist', args: ['/fo', 'csv', '/nh'] };
  }
  if (process.platform === 'darwin') {
    return { executable: 'ps', args: ['-c', '-A', '-o', 'comm'] };
  }
  // Linux and other Unix
  return { executable: 'ps', args: ['-A', '-o', 'comm'] };
}

function parseProcessList(stdout: string): Set<string> {
  const names = new Set<string>();

  if (process.platform === 'win32') {
    // Windows tasklist CSV: "ImageName","PID","SessionName","Session#","MemUsage"
    for (const line of stdout.split('\n')) {
      const match = line.match(/^"([^"]+)"/);
      if (match && match[1]) {
        names.add(match[1].toLowerCase());
      }
    }
  } else {
    // macOS/Linux: one process name per line, first line may be header
    const lines = stdout.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const name = lines[i]?.trim();
      if (!name) continue;
      // Skip header line (COMM or COMMAND)
      if (i === 0 && (name === 'COMM' || name === 'COMMAND')) continue;
      names.add(name.toLowerCase());
    }
  }

  return names;
}

// ─── Poll logic ─────────────────────────────────────────────────────────────

function poll(): void {
  if (isPolling) return; // Previous poll still in-flight
  isPolling = true;

  const { executable, args } = getProcessCommand();

  execFile(executable, args, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
    isPolling = false;

    if (error) {
      if (!hasErrored) {
        console.warn('[ActivityDetector] execFile failed:', error.message, '— stopping detection');
        hasErrored = true;
        stopActivityDetection();
      }
      return;
    }

    const runningProcesses = parseProcessList(stdout);

    // Find first matching game (dictionary order = priority)
    let matchedEntry: GameEntry | null = null;
    for (const entry of gameEntries) {
      for (const proc of entry.processes) {
        if (runningProcesses.has(proc.toLowerCase())) {
          matchedEntry = entry;
          break;
        }
      }
      if (matchedEntry) break;
    }

    if (matchedEntry) {
      if (matchedEntry.id !== currentGameId) {
        // New game detected (or game changed)
        currentGameId = matchedEntry.id;
        currentActivity = {
          type: matchedEntry.type ?? 'playing',
          name: matchedEntry.name,
          timestamps: { start: Date.now() },
        };
        onChangeCallback?.(currentActivity);
      }
      // Same game still running — no change, skip IPC
    } else {
      if (currentGameId !== null) {
        // Game exited
        currentGameId = null;
        currentActivity = null;
        onChangeCallback?.(null);
      }
      // No game was running before either — skip
    }
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startActivityDetection(
  onActivityChange: (activity: Activity | null) => void,
): void {
  if (intervalId) return; // Already running

  // Load from best available local source: cache first, then bundled seed
  const cachePath = path.join(app.getPath('userData'), 'games-cache.json');
  const seedPath = path.join(__dirname, '..', 'resources', 'games.json');

  const cacheResult = loadDictionary(cachePath);
  if (!cacheResult.success) {
    // Cache missing or corrupt — fall back to bundled seed
    const seedResult = loadDictionary(seedPath);
    if (!seedResult.success) {
      console.warn('[ActivityDetector] No valid dictionary found — detection disabled');
      return;
    }
  }

  onChangeCallback = onActivityChange;
  hasErrored = false;

  // Run first poll immediately
  poll();

  // Then poll every 15 seconds
  intervalId = setInterval(poll, POLL_INTERVAL_MS);

  // Fire-and-forget: sync from remote in background
  syncDictionary().catch((err) => {
    console.warn('[ActivityDetector] Sync failed:', err);
  });
}

export function stopActivityDetection(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  onChangeCallback = null;
}

export function getCurrentActivity(): Activity | null {
  return currentActivity;
}
