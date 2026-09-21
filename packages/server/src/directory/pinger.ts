import type Database from 'better-sqlite3';
import type { DirectoryPingError } from '@backspace/shared';
import { config } from '../config.js';
import { getRawDb } from '../db/index.js';
import { getInstanceId } from '../utils/federationEpoch.js';
import { resolveLocalOrigin } from '../routes/federation/origin.js';
import { pingUrl, slotMinute } from '../telemetry/reporter.js';
import { utcDay } from '../telemetry/day.js';
import {
  clearDirectoryDirty, getDocumentVersion, isDirectoryPingReason, onDirectoryDirty, readDirectoryState,
  recordDirectoryPingFailure, recordDirectoryPingSuccess, type DirectoryPingReason,
} from './state.js';

export interface PingerDeps {
  sqlite: Database.Database;
  /** Hub base URL. Empty means the pinger is disabled. */
  endpoint: string;
  /** This instance's public origin, the only thing the ping carries. */
  origin: string;
  /** Spreads the daily slot the way the telemetry reporter spreads its own. */
  instanceId: string;
  fetch: typeof fetch;
  now: () => Date;
  version: string;
  log: { info(msg: string): void; debug(msg: string): void };
}

/**
 * What the pinger remembers between ticks and loses on restart. Nothing here
 * needs to survive a restart: the boot ping resends whatever is dirty, a
 * retired hub is tried once more per boot on purpose, and the per-day slot
 * guard is derived from the persisted error, not from this.
 */
export interface PingerMemory {
  /** Consecutive failures since the last accepted ping; picks the backoff step. */
  failures: number;
  /** Earliest instant the retry loop or the daily rule may send again, in ms. */
  nextRetryAt: number | null;
  /** Document version the hub rejected the origin for; the retry loop waits for the next change. */
  haltedVersion: number | null;
  /** The hub answered 410: nothing is sent until the next boot. */
  retired: boolean;
}

export function createPingerMemory(): PingerMemory {
  return { failures: 0, nextRetryAt: null, haltedVersion: null, retired: false };
}

const BACKOFF_MS: readonly [number, number, number, number] = [60_000, 300_000, 900_000, 3_600_000];
const TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_S = 10;
const DEBOUNCE_MS = 3_000;
const TICK_MS = 60_000;

export type PingOutcome = 'accepted' | 'cooldown' | 'origin-rejected' | 'retired' | 'fetch-failed' | 'failed';

function isTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  const { name } = error as { name: unknown };
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Retry-After is either a number of seconds or an HTTP date. The per-address
 * limiter on the hub sends neither, which is what the default covers.
 */
function retryAfterMs(header: string | null, now: number): number {
  if (header !== null) {
    const value = header.trim();
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  return DEFAULT_RETRY_AFTER_S * 1000;
}

/** The hub's 502 body says why it could not read this instance's document. Anything else reads as no reason. */
async function readFetchReason(response: Response): Promise<DirectoryPingReason | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return undefined;
    const { reason } = body as { reason?: unknown };
    return isDirectoryPingReason(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}

function scheduleRetry(mem: PingerMemory, at: number): void {
  const step = BACKOFF_MS[Math.min(mem.failures, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[3];
  mem.nextRetryAt = at + step;
  mem.failures += 1;
}

function recordFailure(deps: PingerDeps, mem: PingerMemory, error: DirectoryPingError): void {
  recordDirectoryPingFailure(deps.sqlite, error);
  scheduleRetry(mem, error.at);
}

/**
 * One ping: tells the hub to fetch this instance's document, then applies the
 * answer table from section 6 of the spec. The document version is captured
 * before the request so a change that lands while the ping is in flight keeps
 * the dirty flag; the debounce sends the next ping for it.
 *
 * The hub's answer body is never logged.
 */
export async function sendDirectoryPing(deps: PingerDeps, mem: PingerMemory): Promise<PingOutcome> {
  const sentVersion = getDocumentVersion();
  let response: Response | null = null;
  let failure: 'network' | 'timeout' = 'network';
  let cause = '';
  try {
    response = await deps.fetch(pingUrl(deps.endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `backspace-server/${deps.version}`,
      },
      body: JSON.stringify({ schema: 1, origin: deps.origin }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    failure = isTimeout(error) ? 'timeout' : 'network';
    cause = error instanceof Error ? error.message : 'request failed';
  }
  const at = deps.now().getTime();

  if (response === null) {
    recordFailure(deps, mem, { at, status: failure });
    deps.log.debug(`[directory] ping did not go through (${failure}, ${cause}), retrying in ${describeDelay(mem, at)}`);
    return 'failed';
  }

  const { status } = response;
  if (status >= 200 && status < 300) {
    const cleared = recordDirectoryPingSuccess(deps.sqlite, sentVersion, at);
    mem.failures = 0;
    mem.nextRetryAt = null;
    deps.log.debug(cleared
      ? '[directory] ping accepted'
      : '[directory] ping accepted, the document changed in flight so the next change ping is still owed');
    return 'accepted';
  }
  if (status === 429) {
    mem.nextRetryAt = at + retryAfterMs(response.headers.get('retry-after'), at);
    deps.log.debug(`[directory] hub asked for a pause, next ping in ${describeDelay(mem, at)}`);
    return 'cooldown';
  }
  if (status === 400) {
    recordDirectoryPingFailure(deps.sqlite, { at, status: 'origin' });
    mem.haltedVersion = sentVersion;
    deps.log.info(`[directory] the hub rejected this instance's origin (${deps.origin}); no retry until the directory settings change`);
    return 'origin-rejected';
  }
  if (status === 410) {
    clearDirectoryDirty(deps.sqlite);
    recordDirectoryPingFailure(deps.sqlite, { at, status });
    mem.retired = true;
    deps.log.info('[directory] the hub reports the directory as retired, pinging stopped until the next start');
    return 'retired';
  }
  if (status === 502) {
    const reason = await readFetchReason(response);
    if (reason !== undefined) {
      recordFailure(deps, mem, { at, status: 'fetch', reason });
      deps.log.debug(`[directory] the hub could not read this instance's document (${reason}), retrying in ${describeDelay(mem, at)}`);
      return 'fetch-failed';
    }
  }
  recordFailure(deps, mem, { at, status });
  deps.log.debug(`[directory] ping did not go through (status ${status}), retrying in ${describeDelay(mem, at)}`);
  return 'failed';
}

function describeDelay(mem: PingerMemory, at: number): string {
  const ms = mem.nextRetryAt === null ? 0 : Math.max(0, mem.nextRetryAt - at);
  return `${Math.round(ms / 1000)}s`;
}

function retryDue(mem: PingerMemory, nowMs: number): boolean {
  return mem.nextRetryAt === null || nowMs >= mem.nextRetryAt;
}

/**
 * One pass of the minute timer. In order: the boot ping, the retry loop for a
 * dirty flag, the daily refresh while listed. Returns 'sent' when a ping was
 * attempted, whatever the hub answered.
 *
 * The retry loop runs while dirty regardless of the toggle: an instance that
 * switched itself off while the hub was unreachable still has to tell the hub
 * so, or it sits in the feed until the hub's own recheck drops it.
 *
 * The daily rule's per-day guard comes from the persisted error, not from
 * memory, so a restart loop cannot re-attempt a failing hub more than once a
 * day by the slot. It also waits out nextRetryAt: a 429 at the slot is not
 * retried every minute until the hub relents, and a backoff set by the retry
 * loop is not bypassed by the slot.
 */
export async function pingerTick(deps: PingerDeps, mem: PingerMemory, opts: { boot?: boolean } = {}): Promise<'sent' | 'skipped'> {
  if (deps.endpoint === '' || mem.retired) return 'skipped';
  const state = readDirectoryState(deps.sqlite);
  const now = deps.now();
  const nowMs = now.getTime();

  if (opts.boot === true && (state.enabled || state.dirty)) {
    await sendDirectoryPing(deps, mem);
    return 'sent';
  }

  if (state.dirty && mem.haltedVersion !== getDocumentVersion() && retryDue(mem, nowMs)) {
    await sendDirectoryPing(deps, mem);
    return 'sent';
  }

  if (state.enabled) {
    const today = utcDay(now);
    const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
    const slot = slotMinute(deps.instanceId);
    const todaySlotInstant = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, slot);
    const slotReached = minuteOfDay >= slot;
    const notYetToday = state.lastPingAt === null || state.lastPingAt < todaySlotInstant;
    const notAttemptedToday = state.lastError === null || utcDay(new Date(state.lastError.at)) !== today;
    if (slotReached && notYetToday && notAttemptedToday && retryDue(mem, nowMs)) {
      await sendDirectoryPing(deps, mem);
      return 'sent';
    }
  }

  return 'skipped';
}

let interval: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

function productionDeps(): PingerDeps {
  return {
    sqlite: getRawDb(),
    endpoint: config.directory.endpoint,
    origin: resolveLocalOrigin(),
    instanceId: getInstanceId(),
    fetch: globalThis.fetch,
    now: () => new Date(),
    version: config.version,
    log: { info: (m) => console.log(m), debug: () => undefined },
  };
}

/**
 * Boot ping once, a tick every minute, and a 3 second debounced ping on every
 * dirty mark so a burst of edits sends one ping. Started outside the
 * federation workers guard on purpose: the two-instance harness disables the
 * workers and still needs the pinger, pointed at a local stub.
 */
export function startDirectoryPinger(): void {
  if (interval) return;
  if (config.directory.endpoint === '') {
    console.log('[directory] pinger disabled, DIRECTORY_ENDPOINT is empty');
    return;
  }
  const deps = productionDeps();
  const mem = createPingerMemory();
  const report = (err: unknown) => {
    console.error('[directory] pinger failed:', err);
  };

  unsubscribe = onDirectoryDirty(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (mem.retired) return;
      sendDirectoryPing(deps, mem).catch(report);
    }, DEBOUNCE_MS);
  });

  console.log(`[directory] pinger started, hub ${deps.endpoint}, origin ${deps.origin}`);
  pingerTick(deps, mem, { boot: true }).catch(report);
  interval = setInterval(() => {
    pingerTick(deps, mem).catch(report);
  }, TICK_MS);
}

export function stopDirectoryPinger(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
