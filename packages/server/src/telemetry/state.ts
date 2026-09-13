import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TelemetryStatus } from '@backspace/shared';

interface Row {
  telemetry_enabled: number | null;
  telemetry_id: string | null;
  telemetry_last_day: string | null;
  telemetry_last_error: string | null;
}

function parseError(raw: string | null): TelemetryStatus['lastError'] {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null
      && typeof (parsed as { day?: unknown }).day === 'string'
      && typeof (parsed as { status?: unknown }).status === 'number') {
      return { day: (parsed as { day: string }).day, status: (parsed as { status: number }).status };
    }
  } catch {
    // A corrupt value reads as no error rather than breaking the settings read.
  }
  return null;
}

export function readTelemetryState(sqlite: Database.Database): TelemetryStatus {
  const row = sqlite.prepare(
    'SELECT telemetry_enabled, telemetry_id, telemetry_last_day, telemetry_last_error FROM instance_settings WHERE id = 1',
  ).get() as Row | undefined;
  if (!row) return { enabled: null, id: null, lastDay: null, lastError: null };
  return {
    enabled: row.telemetry_enabled === null ? null : row.telemetry_enabled === 1,
    id: row.telemetry_id,
    lastDay: row.telemetry_last_day,
    lastError: parseError(row.telemetry_last_error),
  };
}

/**
 * The single on/off transition. The id is minted once, the first time the
 * instance is switched on, and kept for the life of the install: switching off
 * stops the pings, switching on again reuses the same id. A stable id is what
 * Home Assistant and Grafana do, and it keeps a re-enabled instance from
 * looking like a new one to the receiver, restarting its two-days-in-thirty
 * qualification and moving its slot minute.
 *
 * Neither branch writes `telemetry_last_day`. That column records what the
 * reporter actually sent and belongs to `recordTelemetrySuccess` alone.
 * Stamping it here to hold the first ping until tomorrow cost a whole day of
 * data every time an admin flipped the switch twice, and bought nothing: the
 * receiver's primary key is `(instance, day)` and it upserts, so a repeated
 * ping for a day it already holds overwrites that row instead of adding one.
 * Leaving the column alone means a toggle after the day's ping stays quiet
 * because the day is already stamped, a toggle before it still reports at the
 * slot, and an instance switched on after its slot has passed reports within
 * the minute rather than staying dark until tomorrow.
 *
 * The pending error is cleared on both branches: an admin working the switch
 * is asking for another attempt, and the reporter's one-attempt-per-day guard
 * reads that column.
 *
 * Enabling an instance that is already on changes nothing at all. A repeated
 * admin save and a re-run of install.sh with TELEMETRY=on both take this path.
 */
export function setTelemetryEnabled(
  sqlite: Database.Database,
  enabled: boolean,
): TelemetryStatus {
  const current = readTelemetryState(sqlite);
  if (enabled && current.enabled === true) return current;
  if (enabled) {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 1, telemetry_id = COALESCE(telemetry_id, ?), telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
    ).run(crypto.randomUUID(), Date.now());
  } else {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 0, telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
    ).run(Date.now());
  }
  return readTelemetryState(sqlite);
}

export function recordTelemetrySuccess(sqlite: Database.Database, day: string): void {
  sqlite.prepare(
    'UPDATE instance_settings SET telemetry_last_day = ?, telemetry_last_error = NULL WHERE id = 1',
  ).run(day);
}

export function recordTelemetryFailure(sqlite: Database.Database, day: string, status: number): void {
  sqlite.prepare(
    'UPDATE instance_settings SET telemetry_last_error = ? WHERE id = 1',
  ).run(JSON.stringify({ day, status }));
}
