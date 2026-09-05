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
 * The single on/off transition. Enabling mints a fresh id and stamps today as
 * the last reported day so the first ping goes out tomorrow at the slot, never
 * within the minute. Disabling clears the id: a later re-enable is a new
 * anonymous instance as far as the receiver can tell.
 */
export function setTelemetryEnabled(
  sqlite: Database.Database,
  enabled: boolean,
  today: string,
): TelemetryStatus {
  if (enabled) {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 1, telemetry_id = ?, telemetry_last_day = ?, telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
    ).run(crypto.randomUUID(), today, Date.now());
  } else {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 0, telemetry_id = NULL, telemetry_last_day = NULL, telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
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
