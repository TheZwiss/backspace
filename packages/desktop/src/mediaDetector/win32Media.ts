import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface } from 'readline';
import type { MediaTrackInfo } from './types';
import type { MediaChangeCallback } from './darwinMedia';
import { SMTC_MONITOR_SCRIPT } from './win32ProbeScripts';
import { parsePlayerWindowTitle } from './titleParser';

const RESTART_DELAY_MS = 1_000;
const MONITOR_WATCHDOG_MS = 12_000;
const POSITION_DRIFT_TOLERANCE_MS = 1_500;
const PROGRESS_REFRESH_INTERVAL_MS = 10_000;
const NET_EASE_SETUP_HINT_DELAY_MS = 10_000;
const DEBUG_MEDIA = process.env.BACKSPACE_DEBUG_MEDIA === '1';

let monitorProcess: ChildProcess | null = null;
let monitorLines: Interface | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let currentTrack: MediaTrackInfo | null = null;
let currentTrackObservedAt = 0;
let currentTrackReportedAt = 0;
let activeCallback: MediaChangeCallback | null = null;
let activeSetupHintCallback: MediaSetupHintCallback | null = null;
let shouldRun = false;
let lastMonitorError = '';
let netEaseHintSince: number | null = null;
let netEaseHintReported = false;

export const BROWSER_PLAYERS = new Set(['Chrome', 'Edge', 'Firefox', 'Brave', 'Opera', 'Vivaldi', 'Arc']);

export function isBrowserPlayer(player?: string): boolean {
  if (!player) return false;
  return BROWSER_PLAYERS.has(player);
}

export function resolvePlayerFromAppId(appId: string): string {
  const lower = appId.toLowerCase();
  if (isNetEaseAppId(lower)) return 'NetEase Cloud Music';
  if (lower.includes('qqmusic')) return 'QQ Music';
  if (lower.includes('spotify')) return 'Spotify';
  if (lower.includes('applemusic') || lower.includes('music.ui')) return 'Apple Music';
  if (lower.includes('kugou')) return 'KuGou';
  if (lower.includes('kuwo') || lower.includes('kwmusic')) return 'Kuwo';
  if (lower.includes('yandex')) return 'Yandex Music';
  if (lower.includes('foobar')) return 'foobar2000';
  if (lower.includes('aimp')) return 'AIMP';
  if (lower.includes('musicbee')) return 'MusicBee';
  if (lower.includes('msedge') || lower.includes('edge')) return 'Edge';
  if (lower.includes('chrome')) return 'Chrome';
  if (lower.includes('firefox')) return 'Firefox';
  if (lower.includes('brave')) return 'Brave';
  if (lower.includes('opera')) return 'Opera';
  if (lower.includes('vivaldi')) return 'Vivaldi';
  return appId || 'Music';
}

export type MediaSetupHint = 'netease-smtc';
export type MediaSetupHintCallback = (hint: MediaSetupHint) => void;

export function isNetEaseAppId(appId: string): boolean {
  const lower = appId.toLowerCase();
  return lower.includes('cloudmusic') || lower.includes('netease') || lower.includes('163');
}

export type SmtcPlaybackStatus =
  | 'closed'
  | 'opened'
  | 'changing'
  | 'stopped'
  | 'playing'
  | 'paused'
  | 'unknown';

export interface SmtcSessionInfo {
  appId: string;
  player: string;
  status: SmtcPlaybackStatus;
  title: string;
  artist: string;
  positionMs?: number;
  durationMs?: number;
  timelineUpdatedAtMs?: number;
  mediaType: 'music' | 'video';
}

export interface SmtcProbeResult {
  ok: boolean;
  sessions: SmtcSessionInfo[];
  netEase?: {
    running: boolean;
    windowTitle: string;
  };
  error?: string;
}

const SMTC_STATUS: Record<number, SmtcPlaybackStatus> = {
  0: 'closed',
  1: 'opened',
  2: 'changing',
  3: 'stopped',
  4: 'playing',
  5: 'paused',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseSmtcOutput(output: string): SmtcProbeResult {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, sessions: [], error: 'SMTC monitor returned no JSON' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    return {
      ok: false,
      sessions: [],
      error: error instanceof Error ? error.message : 'SMTC monitor returned invalid JSON',
    };
  }

  if (!isRecord(parsed) || parsed.ok !== true || !Array.isArray(parsed.sessions)) {
    return {
      ok: false,
      sessions: [],
      error: isRecord(parsed) && 'error' in parsed
        ? String(parsed.error)
        : 'SMTC monitor failed',
    };
  }

  const sessions: SmtcSessionInfo[] = [];
  for (const value of parsed.sessions) {
    if (!isRecord(value)) continue;

    const appId = typeof value.appId === 'string' ? value.appId : '';
    const statusValue = readFiniteNumber(value.status);
    const positionMs = readFiniteNumber(value.positionMs);
    const durationMs = readFiniteNumber(value.durationMs);
    const timelineUpdatedAtMs = readFiniteNumber(value.timelineUpdatedAtMs);

    sessions.push({
      appId,
      player: resolvePlayerFromAppId(appId),
      status: statusValue === undefined ? 'unknown' : (SMTC_STATUS[statusValue] ?? 'unknown'),
      title: typeof value.title === 'string' ? value.title.trim() : '',
      artist: typeof value.artist === 'string' ? value.artist.trim() : '',
      positionMs: positionMs !== undefined && positionMs >= 0 ? positionMs : undefined,
      durationMs: durationMs !== undefined && durationMs > 0 ? durationMs : undefined,
      timelineUpdatedAtMs: timelineUpdatedAtMs !== undefined && timelineUpdatedAtMs > 0
        ? timelineUpdatedAtMs
        : undefined,
      mediaType: value.mediaType === 'video' ? 'video' : 'music',
    });
  }

  let netEase: SmtcProbeResult['netEase'];
  if (isRecord(parsed.netEase)) {
    netEase = {
      running: parsed.netEase.running === true,
      windowTitle: typeof parsed.netEase.windowTitle === 'string'
        ? parsed.netEase.windowTitle.trim()
        : '',
    };
  }

  return { ok: true, sessions, ...(netEase ? { netEase } : {}) };
}

function currentPositionMs(session: SmtcSessionInfo, now: number): number | undefined {
  if (session.positionMs === undefined) return undefined;
  if (session.status !== 'playing' || session.timelineUpdatedAtMs === undefined) {
    return session.positionMs;
  }

  // SMTC's Position is only current as of LastUpdatedTime, so extrapolate
  // while playing and clamp it to the track duration.
  const elapsed = Math.max(0, now - session.timelineUpdatedAtMs);
  const position = session.positionMs + elapsed;
  return session.durationMs === undefined
    ? position
    : Math.min(session.durationMs, position);
}

export function selectSmtcTrack(
  result: SmtcProbeResult,
  now = Date.now(),
): MediaTrackInfo | null {
  const playing = result.sessions.filter((session) => session.status === 'playing' && session.title);
  const session = playing.find((item) => !isBrowserPlayer(item.player)) || playing[0];
  if (!session) return null;

  return {
    title: session.title,
    artist: session.artist,
    isPlaying: true,
    player: session.player,
    positionMs: currentPositionMs(session, now),
    durationMs: session.durationMs,
    mediaType: session.mediaType,
  };
}

/**
 * NetEase keeps the last song in its window title after pause. With SMTC off
 * the title cannot prove playback, but it is still useful as an explicitly
 * degraded listening status until the process closes or another player wins.
 */
export function selectNetEaseFallbackTrack(result: SmtcProbeResult): MediaTrackInfo | null {
  if (!result.ok || !result.netEase?.running) return null;
  if (result.sessions.some((session) => isNetEaseAppId(session.appId))) return null;

  const parsed = parsePlayerWindowTitle('cloudmusic', result.netEase.windowTitle);
  if (!parsed) return null;

  return {
    title: parsed.title,
    artist: parsed.artist,
    isPlaying: true,
    player: 'NetEase Cloud Music',
  };
}

export function shouldRequestNetEaseSetup(result: SmtcProbeResult): boolean {
  // The window title is used only to decide whether the user is trying to play.
  // It never contributes playback state because NetEase leaves the last song in
  // the title while paused.
  return selectNetEaseFallbackTrack(result) !== null;
}

/**
 * Activity detection still reads tasklist output on Windows for application
 * matching, so keep the shared OEM code-page decoder here.
 */
export function decodeWin32Output(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

function warnMonitor(message: string): void {
  if (lastMonitorError === message) return;
  lastMonitorError = message;
  console.warn('[MediaDetector] Windows SMTC monitor failed:', message);
}

function clearMonitorWarning(): void {
  lastMonitorError = '';
}

function applyDetectedTrack(detected: MediaTrackInfo | null): void {
  const now = Date.now();
  if (detected) {
    const trackChanged = (
      !currentTrack ||
      currentTrack.title !== detected.title ||
      currentTrack.artist !== detected.artist ||
      currentTrack.player !== detected.player
    );
    const expectedPosition = currentTrack?.positionMs === undefined
      ? undefined
      : currentTrack.positionMs + (now - currentTrackObservedAt);
    const positionJumped = (
      expectedPosition !== undefined &&
      detected.positionMs !== undefined &&
      currentTrack?.positionMs !== detected.positionMs &&
      Math.abs(detected.positionMs - expectedPosition) > POSITION_DRIFT_TOLERANCE_MS
    );

    currentTrack = detected;
    currentTrackObservedAt = now;
    // SMTC's timeline is not trustworthy enough to send once and let every
    // client extrapolate forever. Refresh the shared position periodically so
    // late joins and browser clients converge on the current playback point.
    const progressRefreshDue = !trackChanged
      && now - currentTrackReportedAt >= PROGRESS_REFRESH_INTERVAL_MS;
    if (trackChanged || positionJumped || progressRefreshDue) {
      currentTrackReportedAt = now;
      activeCallback?.(currentTrack);
    }
  } else if (currentTrack !== null) {
    currentTrack = null;
    currentTrackObservedAt = 0;
    currentTrackReportedAt = 0;
    activeCallback?.(null);
  }
}

function clearWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function armWatchdog(): void {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    warnMonitor('no heartbeat received');
    monitorProcess?.kill();
  }, MONITOR_WATCHDOG_MS);
}

function scheduleRestart(): void {
  if (!shouldRun || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startMonitor();
  }, RESTART_DELAY_MS);
}

function handleMonitorLine(line: string): void {
  armWatchdog();

  const result = parseSmtcOutput(line);
  if (!result.ok) {
    warnMonitor(result.error || 'unknown error');
    netEaseHintSince = null;
    applyDetectedTrack(null);
    return;
  }

  clearMonitorWarning();
  reportNetEaseSetupHint(result);
  const track = selectSmtcTrack(result) ?? selectNetEaseFallbackTrack(result);
  if (DEBUG_MEDIA) {
    console.log('[MediaDetector] SMTC state:', JSON.stringify(result));
  }
  applyDetectedTrack(track);
}

function reportNetEaseSetupHint(result: SmtcProbeResult): void {
  if (netEaseHintReported || !shouldRequestNetEaseSetup(result)) {
    netEaseHintSince = null;
    return;
  }

  const now = Date.now();
  netEaseHintSince ??= now;
  if (now - netEaseHintSince < NET_EASE_SETUP_HINT_DELAY_MS) return;

  netEaseHintReported = true;
  netEaseHintSince = null;
  activeSetupHintCallback?.('netease-smtc');
}

function closeMonitorResources(): void {
  monitorLines?.close();
  monitorLines = null;
  monitorProcess = null;
  clearWatchdog();
}

function startMonitor(): void {
  if (!shouldRun || monitorProcess) return;

  const child = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SMTC_MONITOR_SCRIPT],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  monitorProcess = child;
  armWatchdog();

  if (child.stdout) {
    monitorLines = createInterface({ input: child.stdout });
    monitorLines.on('line', handleMonitorLine);
  }

  child.stderr?.on('data', (chunk: Buffer) => {
    const message = chunk.toString('utf8').trim();
    if (message) warnMonitor(message);
  });

  child.on('error', (error) => {
    warnMonitor(error.message);
  });

  child.on('close', (code, signal) => {
    closeMonitorResources();
    applyDetectedTrack(null);
    if (!shouldRun) return;

    const reason = signal ? `signal ${signal}` : `exit code ${String(code)}`;
    warnMonitor(`monitor stopped (${reason})`);
    scheduleRestart();
  });
}

export function startWin32Media(
  callback: MediaChangeCallback,
  onSetupHint?: MediaSetupHintCallback,
): void {
  activeCallback = callback;
  activeSetupHintCallback = onSetupHint ?? null;
  if (process.platform !== 'win32') return;

  shouldRun = true;
  startMonitor();
}

export function stopWin32Media(): void {
  shouldRun = false;
  clearWatchdog();
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  monitorLines?.close();
  monitorLines = null;
  monitorProcess?.kill();
  monitorProcess = null;
  currentTrack = null;
  currentTrackObservedAt = 0;
  currentTrackReportedAt = 0;
  activeCallback = null;
  activeSetupHintCallback = null;
  netEaseHintSince = null;
}
