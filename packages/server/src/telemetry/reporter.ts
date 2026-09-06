import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import { getRawDb } from '../db/index.js';
import { utcDay } from './day.js';
import { buildTelemetryPayload, payloadContextFromConfig, type PayloadContext } from './payload.js';
import { readTelemetryState, recordTelemetryFailure, recordTelemetrySuccess, setTelemetryEnabled } from './state.js';

export interface ReporterDeps {
  sqlite: Database.Database;
  endpoint: string;
  fetch: typeof fetch;
  now: () => Date;
  context: (today: string, telemetryId: string) => PayloadContext;
  log: { info(msg: string): void; debug(msg: string): void };
}

/** Minute of the UTC day this instance reports at, spread by hashing the id. */
export function slotMinute(telemetryId: string): number {
  const digest = crypto.createHash('sha256').update(telemetryId).digest();
  return digest.readUInt16BE(0) % 1440;
}

const TIMEOUT_MS = 10_000;

/** The endpoint is a base URL, so a trailing slash must not double up in the path. */
function pingUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/ping`;
}

/**
 * One pass of the daily job. Sends at most one ping per UTC day, at or after
 * the instance's slot minute, and records the outcome against the row that
 * made the request.
 *
 * The state is read at the start and again after the request resolves: an
 * admin can switch reporting off, or off and on again, while a ping is in
 * flight, and the bookkeeping fields belong to whichever id is current. A row
 * that changed underneath the request keeps what the transition left it.
 *
 * Neither the payload nor the receiver's answer is ever logged.
 */
export async function reporterTick(deps: ReporterDeps): Promise<'sent' | 'skipped' | 'failed' | 'retired'> {
  const state = readTelemetryState(deps.sqlite);
  if (state.enabled !== true || state.id === null) return 'skipped';
  const telemetryId = state.id;

  const now = deps.now();
  const today = utcDay(now);
  if (state.lastDay === today) return 'skipped';
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minuteOfDay < slotMinute(telemetryId)) return 'skipped';
  // One attempt per day: a receiver that answers 500 is not hit every minute
  // until midnight, it is retried tomorrow.
  if (state.lastError?.day === today) return 'skipped';

  const payload = buildTelemetryPayload(deps.sqlite, deps.context(today, telemetryId));
  let status = 0;
  let cause = '';
  try {
    const response = await deps.fetch(pingUrl(deps.endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `backspace-server/${payload.build.version}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
  } catch (error) {
    cause = `, ${error instanceof Error ? error.message : 'request failed'}`;
  }

  const current = readTelemetryState(deps.sqlite);
  if (current.enabled !== true || current.id !== telemetryId) {
    deps.log.debug('[telemetry] reporting was changed while a ping was in flight, nothing recorded');
    return 'skipped';
  }

  if (status >= 200 && status < 300) {
    recordTelemetrySuccess(deps.sqlite, today);
    deps.log.debug(`[telemetry] ping accepted for ${today}`);
    return 'sent';
  }
  if (status === 410) {
    setTelemetryEnabled(deps.sqlite, false, today);
    deps.log.info('[telemetry] the receiver reports the service as retired, reporting switched off');
    return 'retired';
  }
  recordTelemetryFailure(deps.sqlite, today, status);
  deps.log.debug(`[telemetry] ping did not go through (status ${status}${cause}), retrying tomorrow`);
  return 'failed';
}

let timer: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 60_000;

function productionDeps(): ReporterDeps {
  return {
    sqlite: getRawDb(),
    endpoint: config.telemetry.endpoint,
    fetch: globalThis.fetch,
    now: () => new Date(),
    context: (today, id) => payloadContextFromConfig(config, today, id),
    log: { info: (m) => console.log(m), debug: () => undefined },
  };
}

/**
 * Ticks once a minute, and once at boot so an instance that was down at its
 * slot still reports that day.
 */
export function startTelemetryReporter(): void {
  if (timer) return;
  const run = () => {
    reporterTick(productionDeps()).catch((err) => {
      console.error('[telemetry] reporter tick failed:', err);
    });
  };
  run();
  timer = setInterval(run, TICK_MS);
}

export function stopTelemetryReporter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
