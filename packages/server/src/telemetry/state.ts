import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TelemetryStatus } from '@backspace/shared';
import { parseVersion } from '../utils/releaseCheck.js';

interface Row {
  telemetry_enabled: number | null;
  telemetry_id: string | null;
  telemetry_last_day: string | null;
  telemetry_last_error: string | null;
  telemetry_declined_version: string | null;
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

/**
 * `runningVersion` is the server's own version (`config.version`). It is a
 * parameter rather than an import so the rule in `isAskDue` can be exercised
 * against any release without rebuilding the config module.
 */
export function readTelemetryState(sqlite: Database.Database, runningVersion: string): TelemetryStatus {
  const row = sqlite.prepare(
    'SELECT telemetry_enabled, telemetry_id, telemetry_last_day, telemetry_last_error, telemetry_declined_version FROM instance_settings WHERE id = 1',
  ).get() as Row | undefined;
  if (!row) return { enabled: null, id: null, lastDay: null, lastError: null, askDue: true };
  const enabled = row.telemetry_enabled === null ? null : row.telemetry_enabled === 1;
  return {
    enabled,
    id: row.telemetry_id,
    lastDay: row.telemetry_last_day,
    lastError: parseError(row.telemetry_last_error),
    askDue: isAskDue(enabled, row.telemetry_declined_version, runningVersion),
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
 *
 * Switching off stamps `telemetry_declined_version` with the running version,
 * whatever reached it: the modal's no, the panel's toggle, `install.sh` (which
 * mirrors this statement inline) and the receiver's 410 retirement. That
 * stamp is what keeps the ask quiet for the rest of that minor release and
 * brings it back on the next one; see `isAskDue`. Switching on leaves the
 * stamp alone, since a yes ends the ask regardless.
 */
export function setTelemetryEnabled(
  sqlite: Database.Database,
  enabled: boolean,
  runningVersion: string,
): TelemetryStatus {
  const current = readTelemetryState(sqlite, runningVersion);
  if (enabled && current.enabled === true) return current;
  if (enabled) {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 1, telemetry_id = COALESCE(telemetry_id, ?), telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
    ).run(crypto.randomUUID(), Date.now());
  } else {
    sqlite.prepare(
      'UPDATE instance_settings SET telemetry_enabled = 0, telemetry_declined_version = ?, telemetry_last_error = NULL, updated_at = ? WHERE id = 1',
    ).run(runningVersion, Date.now());
  }
  return readTelemetryState(sqlite, runningVersion);
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

/**
 * Whether the admin should be asked. Never answered: always. Said yes: never.
 * Said no: quiet on the minor the decline was made on and its patches, due
 * again on the next minor or major. A decline that recorded no version (one
 * made before the column existed) is due, so those instances are asked once
 * more and then follow the rule. A version that does not parse on either
 * side reads as not due: a fork with a custom label is asked while it has
 * never answered and left alone after its one no, rather than being nagged
 * on every page load because its version never "advances". A downgrade is
 * quiet for the same reason it is quiet on a patch.
 */
export function isAskDue(enabled: boolean | null, declinedVersion: string | null, runningVersion: string): boolean {
  if (enabled === null) return true;
  if (enabled) return false;
  if (declinedVersion === null) return true;
  const declined = parseVersion(declinedVersion);
  const running = parseVersion(runningVersion);
  if (declined === null || running === null) return false;
  if (running[0] !== declined[0]) return running[0] > declined[0];
  return running[1] > declined[1];
}
