import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from '../db/migrate.js';
import { slotMinute } from '../telemetry/reporter.js';
import { readDirectoryState, markDirectoryDirty, getDocumentVersion, recordDirectoryPingSuccess, _resetDirectoryStateForTests } from './state.js';
import {
  sendDirectoryPing, pingerTick, createPingerMemory, changePingDelay, createChangePingScheduler,
  type PingerDeps, type PingerMemory,
} from './pinger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;
let mem: PingerMemory;

function deps(nowIso: string, respond: () => Response | Promise<Response>): PingerDeps {
  fetchMock = vi.fn().mockImplementation(respond);
  return {
    sqlite: db, endpoint: 'https://hub.test', origin: 'https://home.test', instanceId: 'epoch-1',
    fetch: fetchMock as unknown as typeof fetch, now: () => new Date(nowIso), version: '1.4.0',
    log: { info: vi.fn(), debug: vi.fn() },
  };
}

const ok = () => new Response(null, { status: 204 });
const answer = (status: number, body: string | null = null, headers: Record<string, string> = {}) =>
  () => new Response(body, { status, headers });

function enable(): void {
  db.prepare('UPDATE instance_settings SET directory_enabled = 1 WHERE id = 1').run();
}
function setLastPing(iso: string): void {
  db.prepare('UPDATE instance_settings SET directory_last_ping_at = ? WHERE id = 1').run(Date.parse(iso));
}

// Hashes to minute 540, so the daily cases can talk about a 09:00 UTC slot.
const NINE_AM_ID = 'slot-probe-920';

beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
  ensureDefaults(db);
  _resetDirectoryStateForTests();
  mem = createPingerMemory();
});

describe('sendDirectoryPing', () => {
  it('posts only the origin, with the json content type and the server user agent', async () => {
    markDirectoryDirty(db);
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', ok), mem)).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hub.test/v1/ping');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"schema":1,"origin":"https://home.test"}');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toBe('backspace-server/1.4.0');
  });

  it('204 clears dirty when the document is unchanged, stamps the ping and resets the retry state', async () => {
    markDirectoryDirty(db);
    mem.failures = 3;
    mem.nextRetryAt = 42;
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', ok), mem)).toBe('accepted');
    expect(readDirectoryState(db)).toEqual({
      enabled: false, dirty: false, lastPingAt: Date.parse('2026-09-22T10:00:00Z'), lastError: null,
    });
    expect(mem).toEqual({ failures: 0, nextRetryAt: null, haltedVersion: null, retired: false });
  });

  it('204 after a change that landed in flight leaves dirty set for the debounce, not the retry loop', async () => {
    markDirectoryDirty(db);
    const d = deps('2026-09-22T10:00:00Z', () => { markDirectoryDirty(db); return ok(); });
    expect(await sendDirectoryPing(d, mem)).toBe('accepted');
    expect(readDirectoryState(db)).toMatchObject({ dirty: true, lastPingAt: Date.parse('2026-09-22T10:00:00Z'), lastError: null });
    expect(mem.nextRetryAt).toBeNull();
    expect(mem.failures).toBe(0);
  });

  it('429 honours Retry-After and keeps dirty without recording an error', async () => {
    markDirectoryDirty(db);
    const now = Date.parse('2026-09-22T10:00:00Z');
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', answer(429, null, { 'retry-after': '7' })), mem)).toBe('cooldown');
    expect(mem.nextRetryAt).toBe(now + 7000);
    expect(mem.failures).toBe(0);
    expect(readDirectoryState(db)).toMatchObject({ dirty: true, lastError: null, lastPingAt: null });
  });

  it('429 without the header waits the default ten seconds', async () => {
    markDirectoryDirty(db);
    const now = Date.parse('2026-09-22T10:00:00Z');
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', answer(429)), mem)).toBe('cooldown');
    expect(mem.nextRetryAt).toBe(now + 10_000);
    expect(readDirectoryState(db).dirty).toBe(true);
  });

  it('400 records an origin rejection and halts the retry loop until the next change', async () => {
    markDirectoryDirty(db);
    const now = Date.parse('2026-09-22T10:00:00Z');
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', answer(400)), mem)).toBe('origin-rejected');
    expect(readDirectoryState(db)).toMatchObject({ dirty: true, lastError: { at: now, status: 'origin' } });
    expect(mem.haltedVersion).toBe(getDocumentVersion());

    expect(await pingerTick(deps('2026-09-22T10:01:00Z', ok), mem)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();

    markDirectoryDirty(db);
    expect(await pingerTick(deps('2026-09-22T10:02:00Z', ok), mem)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDirectoryState(db)).toMatchObject({ dirty: false, lastError: null });
  });

  it('410 clears dirty, records the status and retires the pinger until the next boot', async () => {
    markDirectoryDirty(db);
    enable();
    const now = Date.parse('2026-09-22T10:00:00Z');
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', answer(410)), mem)).toBe('retired');
    expect(readDirectoryState(db)).toMatchObject({ dirty: false, lastError: { at: now, status: 410 } });
    expect(mem.retired).toBe(true);

    markDirectoryDirty(db);
    expect(await pingerTick(deps('2026-09-22T10:01:00Z', ok), mem, { boot: true })).toBe('skipped');
    expect(await pingerTick(deps('2026-09-23T10:01:00Z', ok), mem)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('502 with a reason records a fetch failure, keeps dirty and backs off 1, 5, 15, 60, 60 minutes', async () => {
    markDirectoryDirty(db);
    const now = Date.parse('2026-09-22T10:00:00Z');
    const d = deps('2026-09-22T10:00:00Z', answer(502, '{"reason":"origin-mismatch"}', { 'content-type': 'application/json' }));
    expect(await sendDirectoryPing(d, mem)).toBe('fetch-failed');
    expect(readDirectoryState(db)).toMatchObject({ dirty: true, lastError: { at: now, status: 'fetch', reason: 'origin-mismatch' } });
    expect(mem.failures).toBe(1);
    expect(mem.nextRetryAt).toBe(now + 60_000);

    expect(await sendDirectoryPing(d, mem)).toBe('fetch-failed');
    expect(mem.nextRetryAt).toBe(now + 300_000);
    expect(await sendDirectoryPing(d, mem)).toBe('fetch-failed');
    expect(mem.nextRetryAt).toBe(now + 900_000);
    expect(await sendDirectoryPing(d, mem)).toBe('fetch-failed');
    expect(mem.nextRetryAt).toBe(now + 3_600_000);
    expect(await sendDirectoryPing(d, mem)).toBe('fetch-failed');
    expect(mem.nextRetryAt).toBe(now + 3_600_000);
    expect(mem.failures).toBe(5);
  });

  it('502 without a usable reason and any other status record the status and back off', async () => {
    markDirectoryDirty(db);
    const now = Date.parse('2026-09-22T10:00:00Z');
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', answer(502, '{"reason":"made-up"}')), mem)).toBe('failed');
    expect(readDirectoryState(db).lastError).toEqual({ at: now, status: 502 });
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', answer(502, 'not json')), mem)).toBe('failed');
    expect(readDirectoryState(db).lastError).toEqual({ at: now, status: 502 });
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', answer(503)), mem)).toBe('failed');
    expect(readDirectoryState(db)).toMatchObject({ dirty: true, lastError: { at: now, status: 503 } });
    expect(mem.failures).toBe(3);
    expect(mem.nextRetryAt).toBe(now + 900_000);
  });

  it('a rejected fetch is a network failure; a timeout or abort is a timeout', async () => {
    markDirectoryDirty(db);
    const now = Date.parse('2026-09-22T10:00:00Z');
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', () => Promise.reject(new Error('offline'))), mem)).toBe('failed');
    expect(readDirectoryState(db).lastError).toEqual({ at: now, status: 'network' });
    expect(mem.nextRetryAt).toBe(now + 60_000);

    const timeout = () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', timeout), mem)).toBe('failed');
    expect(readDirectoryState(db).lastError).toEqual({ at: now, status: 'timeout' });

    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    expect(await sendDirectoryPing(deps('2026-09-22T10:00:00Z', () => Promise.reject(abortError)), mem)).toBe('failed');
    expect(readDirectoryState(db).lastError).toEqual({ at: now, status: 'timeout' });
    expect(readDirectoryState(db).dirty).toBe(true);
    expect(mem.failures).toBe(3);
  });
});

describe('pingerTick', () => {
  it('never fetches with an empty endpoint', async () => {
    markDirectoryDirty(db);
    enable();
    const d = { ...deps('2026-09-22T10:00:00Z', ok), endpoint: '' };
    expect(await pingerTick(d, mem, { boot: true })).toBe('skipped');
    expect(await pingerTick(d, mem)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readDirectoryState(db).dirty).toBe(true);
  });

  it('boot sends when enabled even though the daily rule is not due', async () => {
    enable();
    // Slot for epoch-1 is early in the day; a ping after it means the daily rule is satisfied.
    const slot = slotMinute('epoch-1');
    setLastPing(new Date(Date.UTC(2026, 8, 22, 0, slot + 1)).toISOString());
    expect(await pingerTick(deps('2026-09-22T23:00:00Z', ok), mem)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await pingerTick(deps('2026-09-22T23:00:00Z', ok), mem, { boot: true })).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('boot does not send when disabled and clean', async () => {
    expect(await pingerTick(deps('2026-09-22T23:00:00Z', ok), mem, { boot: true })).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('boot sends when disabled and dirty', async () => {
    markDirectoryDirty(db);
    expect(await pingerTick(deps('2026-09-22T23:00:00Z', ok), mem, { boot: true })).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDirectoryState(db).dirty).toBe(false);
  });

  it('daily: waits for the slot, sends once, and does not repeat that day', async () => {
    enable();
    setLastPing('2026-09-21T12:00:00Z');
    const at = (iso: string) => ({ ...deps(iso, ok), instanceId: NINE_AM_ID });
    expect(slotMinute(NINE_AM_ID)).toBe(540);
    expect(await pingerTick(at('2026-09-22T08:59:00Z'), mem)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await pingerTick(at('2026-09-22T09:00:00Z'), mem)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDirectoryState(db).lastPingAt).toBe(Date.parse('2026-09-22T09:00:00Z'));
    expect(await pingerTick(at('2026-09-22T09:01:00Z'), mem)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('daily: an event ping earlier in the day does not satisfy the slot', async () => {
    enable();
    setLastPing('2026-09-22T00:05:00Z');
    const d = { ...deps('2026-09-22T09:00:00Z', ok), instanceId: NINE_AM_ID };
    expect(await pingerTick(d, mem)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('daily: does not run while disabled', async () => {
    setLastPing('2026-09-21T12:00:00Z');
    const d = { ...deps('2026-09-22T09:00:00Z', ok), instanceId: NINE_AM_ID };
    expect(await pingerTick(d, mem)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('daily: a 429 cooldown is respected by the next ticks', async () => {
    enable();
    setLastPing('2026-09-21T12:00:00Z');
    const at = (iso: string, respond: () => Response) => ({ ...deps(iso, respond), instanceId: NINE_AM_ID });
    expect(await pingerTick(at('2026-09-22T09:00:00Z', answer(429, null, { 'retry-after': '3600' })), mem)).toBe('sent');
    expect(await pingerTick(at('2026-09-22T09:01:00Z', ok), mem)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await pingerTick(at('2026-09-22T10:00:00Z', ok), mem)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('per-day guard survives a restart: one slot attempt per day, unless dirty', async () => {
    enable();
    setLastPing('2026-09-21T12:00:00Z');
    const at = (iso: string, respond: () => Response) => ({ ...deps(iso, respond), instanceId: NINE_AM_ID });
    expect(await pingerTick(at('2026-09-22T09:00:00Z', answer(503)), mem)).toBe('sent');
    expect(readDirectoryState(db)).toMatchObject({
      dirty: false, lastPingAt: Date.parse('2026-09-21T12:00:00Z'),
      lastError: { at: Date.parse('2026-09-22T09:00:00Z'), status: 503 },
    });

    const fresh = createPingerMemory();
    expect(await pingerTick(at('2026-09-22T11:00:00Z', ok), fresh)).toBe('skipped');
    expect(await pingerTick(at('2026-09-22T23:59:00Z', ok), fresh)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();

    markDirectoryDirty(db);
    expect(await pingerTick(at('2026-09-22T23:59:30Z', ok), fresh)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDirectoryState(db)).toMatchObject({ dirty: false, lastError: null });

    expect(await pingerTick(at('2026-09-23T09:00:00Z', answer(503)), createPingerMemory())).toBe('sent');
  });

  it('retry: waits for nextRetryAt while dirty, then sends regardless of the toggle', async () => {
    markDirectoryDirty(db);
    const now = Date.parse('2026-09-22T10:00:00Z');
    mem.nextRetryAt = now + 1;
    expect(await pingerTick(deps('2026-09-22T10:00:00Z', ok), mem)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    mem.nextRetryAt = now - 1;
    expect(readDirectoryState(db).enabled).toBe(false);
    expect(await pingerTick(deps('2026-09-22T10:00:00Z', ok), mem)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDirectoryState(db).dirty).toBe(false);
  });
});

describe('changePingDelay', () => {
  const now = Date.parse('2026-09-22T10:00:00Z');

  it('is the three second debounce with nothing running', () => {
    expect(changePingDelay(mem, now)).toBe(3_000);
  });

  it('is the rest of a running Retry-After or backoff when that is longer', () => {
    mem.nextRetryAt = now + 10_000;
    expect(changePingDelay(mem, now)).toBe(10_000);
    mem.nextRetryAt = now + 1_000;
    expect(changePingDelay(mem, now)).toBe(3_000);
    mem.nextRetryAt = now - 5_000;
    expect(changePingDelay(mem, now)).toBe(3_000);
  });
});

describe('createChangePingScheduler', () => {
  const report = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T10:00:00Z'));
    report.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The scheduler reads the clock through deps.now, so the fake clock is what it sees.
  const live = (respond: () => Response) => ({ ...deps('2026-09-22T10:00:00Z', respond), now: () => new Date() });

  it('a burst of dirty marks inside the debounce sends one ping three seconds after the last', async () => {
    const scheduler = createChangePingScheduler(live(ok), mem, report);
    markDirectoryDirty(db);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(2_000);
    markDirectoryDirty(db);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDirectoryState(db).dirty).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });

  it('waits out a running Retry-After instead of sending into the cooldown', async () => {
    const scheduler = createChangePingScheduler(live(ok), mem, report);
    mem.nextRetryAt = Date.now() + 10_000;
    markDirectoryDirty(db);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 429 re-arms the timer for the end of the cooldown, not the next minute tick', async () => {
    let calls = 0;
    const respond = () => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '10' } }) : ok();
    };
    const scheduler = createChangePingScheduler(live(respond), mem, report);
    markDirectoryDirty(db);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDirectoryState(db).dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readDirectoryState(db).dirty).toBe(false);
    expect(mem.nextRetryAt).toBeNull();
  });

  it('a failure other than a cooldown leaves the retry to the minute tick', async () => {
    const scheduler = createChangePingScheduler(live(answer(503)), mem, report);
    markDirectoryDirty(db);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDirectoryState(db).dirty).toBe(true);
  });

  it('sends nothing when a ping in flight already covered the change', async () => {
    const scheduler = createChangePingScheduler(live(ok), mem, report);
    markDirectoryDirty(db);
    scheduler.schedule();
    recordDirectoryPingSuccess(db, getDocumentVersion(), Date.now());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing while the retry loop is halted on the current version, and again after the next change', async () => {
    const scheduler = createChangePingScheduler(live(ok), mem, report);
    markDirectoryDirty(db);
    mem.haltedVersion = getDocumentVersion();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).not.toHaveBeenCalled();
    markDirectoryDirty(db);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing once retired, and nothing after stop', async () => {
    const scheduler = createChangePingScheduler(live(ok), mem, report);
    mem.retired = true;
    markDirectoryDirty(db);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).not.toHaveBeenCalled();

    mem.retired = false;
    scheduler.schedule();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
