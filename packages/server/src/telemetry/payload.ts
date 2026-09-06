import type Database from 'better-sqlite3';
import type { ClientKind, TelemetryPayload } from '@backspace/shared';
import { addDays } from './day.js';
import { roundTwoSignificant } from './rounding.js';
import type { config as serverConfig } from '../config.js';

/**
 * Everything the payload needs that does not come out of the database. Kept
 * separate from `config` so the builder stays a pure function of its inputs
 * and the tests never have to reach into the process environment.
 */
export interface PayloadContext {
  today: string;
  telemetryId: string;
  version: string;
  commit: string | null;
  modified: boolean;
  voice: boolean;
  domainSet: boolean;
  registrationOpenDefault: boolean;
  installChannel: string | undefined;
  os: string;
  arch: string;
  nodeMajor: number;
}

// Kept in step with config.ts: an instance whose AGPL section 13 source offer
// points anywhere else is running a fork, and reports itself as modified.
const UPSTREAM_SOURCE_URL = 'https://github.com/TheZwiss/backspace';

export function payloadContextFromConfig(
  cfg: typeof serverConfig,
  today: string,
  telemetryId: string,
): PayloadContext {
  return {
    today,
    telemetryId,
    version: cfg.version,
    commit: cfg.commit,
    modified: cfg.sourceCodeUrl !== UPSTREAM_SOURCE_URL,
    voice: Boolean(cfg.livekit.url && cfg.livekit.apiKey && cfg.livekit.apiSecret),
    domainSet: Boolean(cfg.domain),
    registrationOpenDefault: cfg.registrationOpen,
    installChannel: cfg.updates.installChannel,
    os: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
  };
}

/**
 * Registered and active users are local accounts only. A row with a
 * `home_instance` is a replicated remote identity: it belongs to whichever
 * instance is that user's home and counting it here would report the same
 * person from every instance that ever saw them.
 */
const LOCAL_USER = 'home_instance IS NULL AND (is_deleted IS NULL OR is_deleted = 0)';

interface SettingsRow {
  registration_open: number | null;
  federation_relay_enabled: number;
  installed_at: number | null;
}

function count(sqlite: Database.Database, sql: string, ...params: unknown[]): number {
  const row = sqlite.prepare(sql).get(...params) as { n: number | null } | undefined;
  return row?.n ?? 0;
}

function install(channel: string | undefined): 'prebuilt' | 'source' | null {
  return channel === 'prebuilt' || channel === 'source' ? channel : null;
}

export function buildTelemetryPayload(sqlite: Database.Database, ctx: PayloadContext): TelemetryPayload {
  const { today } = ctx;
  const activeSince7d = addDays(today, -6);
  const activeSince30d = addDays(today, -29);
  const sevenDaysAgoMs = Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000;

  const settings = sqlite.prepare(
    'SELECT registration_open, federation_relay_enabled, installed_at FROM instance_settings WHERE id = 1',
  ).get() as SettingsRow | undefined;

  const registered = count(sqlite, `SELECT COUNT(*) AS n FROM users WHERE ${LOCAL_USER}`);
  const active1d = count(sqlite, `SELECT COUNT(*) AS n FROM users WHERE ${LOCAL_USER} AND last_active_day = ?`, today);
  const active7d = count(sqlite, `SELECT COUNT(*) AS n FROM users WHERE ${LOCAL_USER} AND last_active_day >= ?`, activeSince7d);
  const active30d = count(sqlite, `SELECT COUNT(*) AS n FROM users WHERE ${LOCAL_USER} AND last_active_day >= ?`, activeSince30d);

  // A client the server never saw reports as web: that is what an account
  // created through the browser and never used elsewhere looks like.
  const clientRows = sqlite.prepare(
    `SELECT COALESCE(last_client, 'web') AS client, COUNT(*) AS n FROM users WHERE ${LOCAL_USER} AND last_active_day >= ? GROUP BY client`,
  ).all(activeSince7d) as Array<{ client: string; n: number }>;
  const clients: Record<ClientKind, number> = { web: 0, desktop: 0, mobile: 0 };
  for (const row of clientRows) {
    if (row.client === 'desktop') clients.desktop += row.n;
    else if (row.client === 'mobile') clients.mobile += row.n;
    else clients.web += row.n;
  }

  // Space content only. DM channels and DM messages live in their own tables
  // and are deliberately left out, here and in every later schema.
  const spaces = count(sqlite, 'SELECT COUNT(*) AS n FROM spaces');
  const channels = count(sqlite, 'SELECT COUNT(*) AS n FROM channels');
  const messages = count(sqlite, 'SELECT COUNT(*) AS n FROM messages');
  const messages7d = count(sqlite, 'SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', sevenDaysAgoMs);
  // Locally uploaded files only. A row with a source_url is a replicated copy
  // of a peer's file and is that peer's storage to report.
  const storageBytes = count(sqlite, 'SELECT SUM(size) AS n FROM attachments WHERE source_url IS NULL');
  const peers = count(sqlite, "SELECT COUNT(*) AS n FROM federation_peers WHERE status = 'active'");

  const registrationOverride = settings?.registration_open ?? null;
  const registrationOpen = registrationOverride === null
    ? ctx.registrationOpenDefault
    : registrationOverride === 1;

  // Month precision, never finer: the install date is a cohort, not an event.
  // ensureDefaults backfills installed_at on boot, so the fallback only covers
  // a database read before that ever ran.
  const installedAt = new Date(settings?.installed_at ?? Date.now()).toISOString().slice(0, 7);

  return {
    schema: 1,
    instance: ctx.telemetryId,
    day: today,
    build: { version: ctx.version, commit: ctx.commit, modified: ctx.modified },
    users: {
      registered: roundTwoSignificant(registered),
      active1d: roundTwoSignificant(active1d),
      active7d: roundTwoSignificant(active7d),
      active30d: roundTwoSignificant(active30d),
    },
    clients: {
      web: roundTwoSignificant(clients.web),
      desktop: roundTwoSignificant(clients.desktop),
      mobile: roundTwoSignificant(clients.mobile),
    },
    content: {
      spaces: roundTwoSignificant(spaces),
      channels: roundTwoSignificant(channels),
      messages: roundTwoSignificant(messages),
      messages7d: roundTwoSignificant(messages7d),
      storageMiB: roundTwoSignificant(Math.floor(storageBytes / (1024 * 1024))),
    },
    features: {
      voice: ctx.voice,
      federation: ctx.domainSet && settings?.federation_relay_enabled === 1,
      peers: roundTwoSignificant(peers),
      registrationOpen,
    },
    runtime: { install: install(ctx.installChannel), os: ctx.os, arch: ctx.arch, node: ctx.nodeMajor },
    installedAt,
  };
}
