import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from '../db/migrate.js';
import {
  readTelemetryState,
  setTelemetryEnabled,
  recordTelemetrySuccess,
  recordTelemetryFailure,
  isAskDue,
} from './state.js';

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

const V = '1.4.0';
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
  ensureDefaults(db);
});

describe('telemetry state', () => {
  it('starts as never asked', () => {
    expect(readTelemetryState(db, V)).toEqual({ enabled: null, id: null, lastDay: null, lastError: null, askDue: true });
  });

  it('mints an id and leaves the last reported day unset on enable', () => {
    const s = setTelemetryEnabled(db, true, V);
    expect(s.enabled).toBe(true);
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    // The day belongs to the reporter. Stamping it here held the first ping
    // until tomorrow and cost a day of data on every toggle.
    expect(s.lastDay).toBeNull();
    expect(s.lastError).toBeNull();
  });

  it('keeps the id across disable and re-enable', () => {
    const first = setTelemetryEnabled(db, true, V).id;
    expect(setTelemetryEnabled(db, false, V)).toMatchObject({ enabled: false, id: first });
    const second = setTelemetryEnabled(db, true, V);
    expect(second.id).toBe(first);
  });

  it('carries the reported day through an off and on again, so a toggle costs no ping', () => {
    setTelemetryEnabled(db, true, V);
    recordTelemetrySuccess(db, '2026-09-06');
    setTelemetryEnabled(db, false, V);
    expect(setTelemetryEnabled(db, true, V).lastDay).toBe('2026-09-06');
  });

  it('mints an id only when there is none', () => {
    db.prepare('UPDATE instance_settings SET telemetry_enabled = 0, telemetry_id = NULL WHERE id = 1').run();
    const first = setTelemetryEnabled(db, true, V).id;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(setTelemetryEnabled(db, false, V).id).toBe(first);
    expect(setTelemetryEnabled(db, true, V).id).toBe(first);
  });

  it('keeps the id and last day when enable is called while already enabled', () => {
    const first = setTelemetryEnabled(db, true, V);
    recordTelemetrySuccess(db, '2026-09-06');
    const second = setTelemetryEnabled(db, true, V);
    expect(second.id).toBe(first.id);
    expect(second.lastDay).toBe('2026-09-06');
    expect(readTelemetryState(db, V)).toMatchObject({ enabled: true, id: first.id, lastDay: '2026-09-06' });
  });

  it('keeps a pending error when enable is called while already enabled', () => {
    setTelemetryEnabled(db, true, V);
    recordTelemetryFailure(db, '2026-09-07', 503);
    expect(setTelemetryEnabled(db, true, V).lastError).toEqual({ day: '2026-09-07', status: 503 });
  });

  it('keeps the last reported day and clears the last error on disable', () => {
    setTelemetryEnabled(db, true, V);
    recordTelemetrySuccess(db, '2026-09-06');
    recordTelemetryFailure(db, '2026-09-07', 503);
    const id = readTelemetryState(db, V).id;
    expect(setTelemetryEnabled(db, false, V)).toEqual({
      enabled: false,
      id,
      lastDay: '2026-09-06',
      lastError: null,
      askDue: false,
    });
  });

  it('records success and failure', () => {
    setTelemetryEnabled(db, true, V);
    recordTelemetryFailure(db, '2026-09-07', 503);
    expect(readTelemetryState(db, V).lastError).toEqual({ day: '2026-09-07', status: 503 });
    recordTelemetrySuccess(db, '2026-09-07');
    expect(readTelemetryState(db, V)).toMatchObject({ lastDay: '2026-09-07', lastError: null });
  });

  it('keeps the id and the last day when a failure is recorded', () => {
    const id = setTelemetryEnabled(db, true, V).id;
    recordTelemetrySuccess(db, '2026-09-06');
    recordTelemetryFailure(db, '2026-09-07', 500);
    expect(readTelemetryState(db, V)).toMatchObject({ enabled: true, id, lastDay: '2026-09-06' });
  });

  it('reads a corrupt last error as no error', () => {
    setTelemetryEnabled(db, true, V);
    db.prepare('UPDATE instance_settings SET telemetry_last_error = ? WHERE id = 1').run('not json');
    expect(readTelemetryState(db, V).lastError).toBeNull();
    db.prepare('UPDATE instance_settings SET telemetry_last_error = ? WHERE id = 1').run('{"day":"2026-09-07"}');
    expect(readTelemetryState(db, V).lastError).toBeNull();
  });
});

describe('the ask across releases', () => {
  it('is due until somebody answers', () => {
    expect(readTelemetryState(db, '1.4.0').askDue).toBe(true);
    expect(readTelemetryState(db, '9.9.9').askDue).toBe(true);
  });

  it('is over for good after a yes', () => {
    setTelemetryEnabled(db, true, '1.4.0');
    expect(readTelemetryState(db, '1.4.0').askDue).toBe(false);
    expect(readTelemetryState(db, '2.0.0').askDue).toBe(false);
  });

  it('stamps the running version on a no and stays quiet until the next minor', () => {
    expect(setTelemetryEnabled(db, false, '1.4.0').askDue).toBe(false);
    expect(readTelemetryState(db, '1.4.5').askDue).toBe(false);
    expect(readTelemetryState(db, '1.5.0').askDue).toBe(true);
  });

  it('re-stamps on a second no so the next quiet period starts from that release', () => {
    setTelemetryEnabled(db, false, '1.4.0');
    expect(setTelemetryEnabled(db, false, '1.5.0').askDue).toBe(false);
    expect(readTelemetryState(db, '1.5.9').askDue).toBe(false);
    expect(readTelemetryState(db, '1.6.0').askDue).toBe(true);
  });

  it('treats switching off in the panel as a no on that release', () => {
    setTelemetryEnabled(db, true, '1.4.0');
    setTelemetryEnabled(db, false, '1.4.2');
    expect(readTelemetryState(db, '1.4.9').askDue).toBe(false);
    expect(readTelemetryState(db, '1.5.0').askDue).toBe(true);
  });

  it('asks a pre-existing no once more when the column is empty', () => {
    db.prepare('UPDATE instance_settings SET telemetry_enabled = 0, telemetry_declined_version = NULL WHERE id = 1').run();
    expect(readTelemetryState(db, '1.4.0').askDue).toBe(true);
  });

  it('keeps the declined version through a yes, and the next no overwrites it', () => {
    setTelemetryEnabled(db, false, '1.4.0');
    setTelemetryEnabled(db, true, '1.5.0');
    const row = db.prepare('SELECT telemetry_declined_version AS v FROM instance_settings WHERE id = 1').get() as { v: string | null };
    expect(row.v).toBe('1.4.0');
    setTelemetryEnabled(db, false, '1.6.0');
    expect(readTelemetryState(db, '1.6.0').askDue).toBe(false);
  });
});

describe('isAskDue', () => {
  it('is due while the instance has never answered, whatever the versions', () => {
    expect(isAskDue(null, null, '1.4.0')).toBe(true);
    expect(isAskDue(null, '1.4.0', '1.4.0')).toBe(true);
    expect(isAskDue(null, null, 'garbage')).toBe(true);
  });

  it('is never due once the instance said yes', () => {
    expect(isAskDue(true, null, '1.4.0')).toBe(false);
    expect(isAskDue(true, '1.3.0', '9.0.0')).toBe(false);
  });

  it('is due after a decline that recorded no version', () => {
    expect(isAskDue(false, null, '1.4.0')).toBe(true);
  });

  it('is quiet on the minor the decline was made on and on its patches', () => {
    expect(isAskDue(false, '1.4.0', '1.4.0')).toBe(false);
    expect(isAskDue(false, '1.4.0', '1.4.3')).toBe(false);
    expect(isAskDue(false, '1.4.2', '1.4.0')).toBe(false);
  });

  it('is due again on the next minor and on a new major', () => {
    expect(isAskDue(false, '1.4.0', '1.5.0')).toBe(true);
    expect(isAskDue(false, '1.4.7', '1.5.0')).toBe(true);
    expect(isAskDue(false, '1.9.0', '2.0.0')).toBe(true);
  });

  it('is quiet on a downgrade', () => {
    expect(isAskDue(false, '1.5.0', '1.4.0')).toBe(false);
    expect(isAskDue(false, '2.0.0', '1.9.0')).toBe(false);
  });

  it('reads a prerelease suffix as its base version', () => {
    expect(isAskDue(false, '1.4.0', '1.5.0-dev')).toBe(true);
    expect(isAskDue(false, '1.4.0-rc.1', '1.4.0')).toBe(false);
  });

  it('is quiet when either version does not parse, so a fork is never nagged', () => {
    expect(isAskDue(false, '1.4.0', 'custom-build')).toBe(false);
    expect(isAskDue(false, 'custom-build', '1.5.0')).toBe(false);
  });
});
