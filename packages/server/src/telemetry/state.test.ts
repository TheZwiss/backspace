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

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
  ensureDefaults(db);
});

describe('telemetry state', () => {
  it('starts as never asked', () => {
    expect(readTelemetryState(db)).toEqual({ enabled: null, id: null, lastDay: null, lastError: null });
  });

  it('mints an id and sets lastDay to today on enable', () => {
    const s = setTelemetryEnabled(db, true, '2026-09-06');
    expect(s.enabled).toBe(true);
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.lastDay).toBe('2026-09-06');
    expect(s.lastError).toBeNull();
  });

  it('clears the id on disable and mints a new one on re-enable', () => {
    const first = setTelemetryEnabled(db, true, '2026-09-06').id;
    expect(setTelemetryEnabled(db, false, '2026-09-06')).toMatchObject({ enabled: false, id: null });
    const second = setTelemetryEnabled(db, true, '2026-09-07').id;
    expect(second).not.toBe(first);
  });

  it('mints a fresh id when enable is called twice in a row', () => {
    const first = setTelemetryEnabled(db, true, '2026-09-06').id;
    const second = setTelemetryEnabled(db, true, '2026-09-07').id;
    expect(second).not.toBe(first);
    expect(readTelemetryState(db).lastDay).toBe('2026-09-07');
  });

  it('clears the last day and the last error on disable', () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    recordTelemetryFailure(db, '2026-09-07', 503);
    expect(setTelemetryEnabled(db, false, '2026-09-07')).toEqual({
      enabled: false,
      id: null,
      lastDay: null,
      lastError: null,
    });
  });

  it('records success and failure', () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    recordTelemetryFailure(db, '2026-09-07', 503);
    expect(readTelemetryState(db).lastError).toEqual({ day: '2026-09-07', status: 503 });
    recordTelemetrySuccess(db, '2026-09-07');
    expect(readTelemetryState(db)).toMatchObject({ lastDay: '2026-09-07', lastError: null });
  });

  it('keeps the id and the last day when a failure is recorded', () => {
    const id = setTelemetryEnabled(db, true, '2026-09-06').id;
    recordTelemetryFailure(db, '2026-09-07', 500);
    expect(readTelemetryState(db)).toMatchObject({ enabled: true, id, lastDay: '2026-09-06' });
  });

  it('reads a corrupt last error as no error', () => {
    setTelemetryEnabled(db, true, '2026-09-06');
    db.prepare('UPDATE instance_settings SET telemetry_last_error = ? WHERE id = 1').run('not json');
    expect(readTelemetryState(db).lastError).toBeNull();
    db.prepare('UPDATE instance_settings SET telemetry_last_error = ? WHERE id = 1').run('{"day":"2026-09-07"}');
    expect(readTelemetryState(db).lastError).toBeNull();
  });
});
