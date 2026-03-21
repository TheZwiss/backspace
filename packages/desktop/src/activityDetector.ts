import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';

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

const VALID_TYPES = new Set(['playing', 'listening', 'watching', 'streaming']);
const POLL_INTERVAL_MS = 15_000;

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

function loadDictionary(): boolean {
  const dictPath = path.join(__dirname, '..', 'resources', 'games.json');

  let raw: string;
  try {
    raw = fs.readFileSync(dictPath, 'utf-8');
  } catch {
    console.warn('[ActivityDetector] games.json not found at', dictPath, '— detection disabled');
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[ActivityDetector] games.json contains malformed JSON — detection disabled');
    return false;
  }

  if (!Array.isArray(parsed)) {
    console.warn('[ActivityDetector] games.json root must be an array — detection disabled');
    return false;
  }

  gameEntries = [];
  processMap = new Map();

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    if (typeof e.id !== 'string' || !e.id) continue;
    if (typeof e.name !== 'string' || !e.name) continue;
    if (!Array.isArray(e.processes) || e.processes.length === 0) continue;
    if (!e.processes.every((p: unknown) => typeof p === 'string')) continue;

    const type = typeof e.type === 'string' && VALID_TYPES.has(e.type) ? e.type : 'playing';

    const gameEntry: GameEntry = {
      id: e.id,
      name: e.name,
      processes: e.processes as string[],
      type,
    };

    gameEntries.push(gameEntry);

    for (const proc of gameEntry.processes) {
      const key = proc.toLowerCase();
      if (!processMap.has(key)) {
        processMap.set(key, gameEntry);
      }
    }
  }

  if (processMap.size === 0) {
    console.warn('[ActivityDetector] No valid entries in games.json — detection disabled');
    return false;
  }

  console.log(`[ActivityDetector] Loaded ${gameEntries.length} games (${processMap.size} process names)`);
  return true;
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

  if (!loadDictionary()) return; // Dictionary failed to load

  onChangeCallback = onActivityChange;
  hasErrored = false;

  // Run first poll immediately
  poll();

  // Then poll every 15 seconds
  intervalId = setInterval(poll, POLL_INTERVAL_MS);
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
