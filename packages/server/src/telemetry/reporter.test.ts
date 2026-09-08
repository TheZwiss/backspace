import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from '../db/migrate.js';
import { readTelemetryState, setTelemetryEnabled } from './state.js';
import { reporterTick, slotMinute, type ReporterDeps } from './reporter.js';
import type { PayloadContext } from './payload.js';

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

const context = (today: string, telemetryId: string): PayloadContext => ({
  today, telemetryId, version: '1.1.2', commit: null, modified: false, voice: false, domainSet: true,
  registrationOpenDefault: true, installChannel: undefined, os: 'linux', arch: 'x64', nodeMajor: 20,
});

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;
const log = { info: vi.fn(), debug: vi.fn() };

function deps(nowIso: string, status = 204): ReporterDeps {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }));
  return { sqlite: db, endpoint: 'https://hello.test', fetch: fetchMock as unknown as typeof fetch, now: () => new Date(nowIso), context, log };
}

beforeEach(() => { db = new Database(':memory:'); applyMigrations(db); ensureDefaults(db); log.info.mockClear(); });

describe('slotMinute', () => {
  it('is stable per id and inside a day', () => {
    const a = slotMinute('3f6c9e2a-0000-4000-8000-000000000000');
    expect(a).toBe(slotMinute('3f6c9e2a-0000-4000-8000-000000000000'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1440);
    expect(slotMinute('other')).not.toBe(a);
  });

  it('reads enough of the digest to tell two close ids apart', () => {
    // These two strings hash to the same first two bytes, so a slot derived
    // from a 16-bit read gives them the same minute. The slot has to look at
    // more of the digest than that, both to keep instances spread out and to
    // keep the modulo bias off the early hours of the day.
    expect(slotMinute('slot-probe-164')).not.toBe(slotMinute('slot-probe-408'));
  });
});

describe('reporterTick', () => {
  it('does nothing while disabled or never asked', async () => {
    expect(await reporterTick(deps('2026-09-07T23:59:00Z'))).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send on the day it was enabled, sends the next day after the slot', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    const id = readTelemetryState(db).id!;
    expect(await reporterTick(deps('2026-09-06T23:59:00Z'))).toBe('skipped');
    const slot = slotMinute(id);
    const before = new Date(Date.UTC(2026, 8, 7, 0, Math.max(slot - 1, 0))).toISOString();
    const after = new Date(Date.UTC(2026, 8, 7, 0, slot)).toISOString();
    if (slot > 0) expect(await reporterTick(deps(before))).toBe('skipped');
    expect(await reporterTick(deps(after))).toBe('sent');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hello.test/v1/ping');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toMatchObject({ schema: 1, instance: id, day: '2026-09-07' });
    expect(readTelemetryState(db).lastDay).toBe('2026-09-07');
    expect(await reporterTick(deps(after))).toBe('skipped');
  });

  it('does not double the slash when the endpoint carries one', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    const d = { ...deps('2026-09-08T23:59:59Z'), endpoint: 'https://hello.test/' };
    expect(await reporterTick(d)).toBe('sent');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://hello.test/v1/ping');
  });

  it('records a failure and leaves lastDay alone', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    expect(await reporterTick(deps('2026-09-08T23:59:59Z', 503))).toBe('failed');
    expect(readTelemetryState(db)).toMatchObject({ lastDay: '2026-09-06', lastError: { day: '2026-09-08', status: 503 } });
  });

  it('makes only one attempt on a day a ping failed', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    expect(await reporterTick(deps('2026-09-08T23:59:00Z', 503))).toBe('failed');
    expect(await reporterTick(deps('2026-09-08T23:59:59Z', 204))).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readTelemetryState(db).lastDay).toBe('2026-09-06');
  });

  it('turns itself off on 410', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    expect(await reporterTick(deps('2026-09-08T23:59:59Z', 410))).toBe('retired');
    expect(readTelemetryState(db)).toMatchObject({ enabled: false, lastDay: null, lastError: null });
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('treats a thrown fetch as a failure with status 0', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    const d = deps('2026-09-08T23:59:59Z');
    (d.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    expect(await reporterTick(d)).toBe('failed');
    expect(readTelemetryState(db).lastError).toEqual({ day: '2026-09-08', status: 0 });
  });

  it('records a status-0 failure when the payload cannot be built', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    // A build that throws (a query against a database in an unexpected state)
    // must burn the day like any other failure. Escaping the tick instead
    // would leave lastError unset and the minute timer would retry the same
    // throw sixty times an hour until midnight.
    db.exec('DROP TABLE messages');
    const d = deps('2026-09-08T23:59:59Z');
    expect(await reporterTick(d)).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readTelemetryState(db).lastError).toEqual({ day: '2026-09-08', status: 0 });
  });

  it('records nothing when telemetry is switched off while the ping is in flight', async () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    const d = deps('2026-09-08T23:59:59Z');
    (d.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      setTelemetryEnabled(db, false, '2026-09-08');
      return new Response(null, { status: 204 });
    });
    expect(await reporterTick(d)).toBe('skipped');
    expect(readTelemetryState(db)).toMatchObject({ enabled: false, lastDay: null, lastError: null });
    expect(readTelemetryState(db).id).not.toBeNull();
  });

  it('records the outcome when telemetry is switched off and on again while the ping is in flight', async () => {
    // The id survives the round trip, so the row the ping came from is still
    // the current row and its bookkeeping applies.
    const id = setTelemetryEnabled(db, true, '2026-09-06').id;
    const d = deps('2026-09-08T23:59:59Z');
    (d.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      setTelemetryEnabled(db, false, '2026-09-08');
      setTelemetryEnabled(db, true, '2026-09-08');
      return new Response(null, { status: 503 });
    });
    expect(await reporterTick(d)).toBe('failed');
    expect(readTelemetryState(db)).toMatchObject({
      enabled: true,
      id,
      lastDay: '2026-09-08',
      lastError: { day: '2026-09-08', status: 503 },
    });
  });
});
