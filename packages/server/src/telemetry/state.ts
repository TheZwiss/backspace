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
 * stops the pings and clears the bookkeeping, switching on again reuses the
 * same id. A stable id is what Home Assistant and Grafana do, and it keeps a
 * re-enabled instance from looking like a new one to the receiver, restarting
 * its two-days-in-thirty qualification and moving its slot minute.
 *
 * Switching on stamps today as the last reported day so the first ping goes
 * out tomorrow at the slot, never within the minute.
 *
 * Enabling an instance that is already on changes nothing. Restamping the
 * last day there would skip that day's ping. A repeated admin save and a
 * re-run of install.sh with TELEMETRY=on both take this path.
 */
export function setTelemetryEnabled(
  sqlite: Database.Database,
  enabled: boolean,
  today: string,
): TelemetryStatus {
  const current = readTelemetryState(sqlite);
  if (enabled && current.enabled === true) return current;
  if (enabled) {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 1, telemetry_id = COALESCE(telemetry_id, ?), telemetry_last_day = ?, telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
    ).run(crypto.randomUUID(), today, Date.now());
  } else {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 0, telemetry_last_day = NULL, telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
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
