import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));
vi.mock('./federationAuth.js', () => ({
  getOurOrigin: () => 'https://home.test',
  buildFederationHeaders: () => ({ 'x-test': '1' }),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('./federationFetch.js', () => ({ federationFetch: fetchMock }));

import {
  BOT_REVOCATION_MAX_AGE_MS,
  hasPendingBotRevocation,
  queueBotRevocations,
  revocationDelayMs,
  revokeBotWithRetry,
  runBotRevocationRetries,
} from './botRevocationQueue.js';

const HOST = 'https://host.test';
const BOT = 'bot-1';
const T0 = 1_800_000_000_000;

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

function seedPeer(origin: string, status = 'active'): void {
  testDb.insert(schema.federationPeers).values({
    id: `peer-${origin}`, origin, hmacSecret: 's', status, nonceSupported: 1, createdAt: T0,
  }).run();
}

const rows = () => testDb.select().from(schema.botRevocations).all();
const answer = (status: number, body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  fetchMock.mockReset();
});

describe('revokeBotWithRetry', () => {
  it('an instance that is away is queued and reported as pending', async () => {
    seedPeer(HOST);
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await revokeBotWithRetry(BOT, [HOST], 'soft');
    expect(out[HOST]).toEqual({ success: false, error: 'unreachable', pending: true });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ botId: BOT, origin: HOST, mode: 'soft', attempts: 1, lastError: 'unreachable' });
  });

  it('an instance that is not peered right now is queued too', async () => {
    const out = await revokeBotWithRetry(BOT, [HOST], 'full');
    expect(out[HOST]).toEqual({ success: false, error: 'no_active_peer', pending: true });
    expect(rows()[0]).toMatchObject({ mode: 'full' });
  });

  it('a revoke that lands leaves no row', async () => {
    seedPeer(HOST);
    fetchMock.mockResolvedValue(answer(200, { success: true }));
    const out = await revokeBotWithRetry(BOT, [HOST], 'soft');
    expect(out[HOST]).toEqual({ success: true });
    expect(rows()).toHaveLength(0);
  });

  it('a refusal that cannot change is reported as final and not queued', async () => {
    seedPeer(HOST);
    fetchMock.mockResolvedValue(answer(403, { error: 'Attribution mismatch' }));
    const out = await revokeBotWithRetry(BOT, [HOST], 'soft');
    expect(out[HOST]).toEqual({ success: false, error: 'Attribution mismatch', pending: false });
    expect(rows()).toHaveLength(0);
  });

  it('a 5xx is retried', async () => {
    seedPeer(HOST);
    fetchMock.mockResolvedValue(answer(503));
    const out = await revokeBotWithRetry(BOT, [HOST], 'soft');
    expect(out[HOST]).toMatchObject({ success: false, pending: true });
    expect(rows()).toHaveLength(1);
  });
});

describe('queueBotRevocations', () => {
  const failure = { success: false as const, error: 'timeout', retry: true };

  it('keeps the original start and never downgrades full to soft', () => {
    queueBotRevocations(BOT, 'full', { [HOST]: failure }, T0);
    queueBotRevocations(BOT, 'soft', { [HOST]: failure }, T0 + 1_000);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ mode: 'full', createdAt: T0 });
  });

  it('upgrades soft to full', () => {
    queueBotRevocations(BOT, 'soft', { [HOST]: failure }, T0);
    queueBotRevocations(BOT, 'full', { [HOST]: failure }, T0 + 1_000);
    expect(rows()[0]).toMatchObject({ mode: 'full', createdAt: T0 });
  });
});

describe('runBotRevocationRetries', () => {
  const queue = (now = T0) =>
    queueBotRevocations(BOT, 'soft', { [HOST]: { success: false, error: 'unreachable', retry: true } }, now);

  it('leaves a row that is not due yet', async () => {
    seedPeer(HOST);
    queue();
    const run = await runBotRevocationRetries(T0 + 1_000);
    expect(run).toEqual({ done: 0, retried: 0, dropped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it('deletes the row when the instance accepts the revoke', async () => {
    seedPeer(HOST);
    queue();
    fetchMock.mockResolvedValue(answer(200, { success: true }));
    const run = await runBotRevocationRetries(T0 + revocationDelayMs(1) + 1);
    expect(run).toEqual({ done: 1, retried: 0, dropped: 0 });
    expect(rows()).toHaveLength(0);
    expect(JSON.parse(fetchMock.mock.calls[0]![2].body as string)).toMatchObject({ homeUserId: BOT, mode: 'soft' });
  });

  it('backs off after another failure', async () => {
    seedPeer(HOST);
    queue();
    fetchMock.mockRejectedValue(new Error('down'));
    const now = T0 + revocationDelayMs(1) + 1;
    const run = await runBotRevocationRetries(now);
    expect(run).toEqual({ done: 0, retried: 1, dropped: 0 });
    expect(rows()[0]).toMatchObject({ attempts: 2, nextAttemptAt: now + revocationDelayMs(2) });
  });

  it('drops a row the instance refuses for good', async () => {
    seedPeer(HOST);
    queue();
    fetchMock.mockResolvedValue(answer(409, { error: 'owns_spaces' }));
    const run = await runBotRevocationRetries(T0 + revocationDelayMs(1) + 1);
    expect(run).toEqual({ done: 0, retried: 0, dropped: 1 });
    expect(rows()).toHaveLength(0);
  });

  it('gives up after seven days without calling the instance', async () => {
    seedPeer(HOST);
    queue();
    const run = await runBotRevocationRetries(T0 + BOT_REVOCATION_MAX_AGE_MS + 1);
    expect(run).toEqual({ done: 0, retried: 0, dropped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it('keeps waiting while the instance is not an active peer', async () => {
    seedPeer(HOST, 'pending');
    queue();
    const run = await runBotRevocationRetries(T0 + revocationDelayMs(1) + 1);
    expect(run).toEqual({ done: 0, retried: 1, dropped: 0 });
    expect(rows()).toHaveLength(1);
  });
});

describe('revocationDelayMs', () => {
  it('doubles from five minutes and stops at six hours', () => {
    expect(revocationDelayMs(0)).toBe(5 * 60_000);
    expect(revocationDelayMs(1)).toBe(10 * 60_000);
    expect(revocationDelayMs(2)).toBe(20 * 60_000);
    expect(revocationDelayMs(20)).toBe(6 * 60 * 60_000);
  });
});

describe('hasPendingBotRevocation', () => {
  it('matches the host by domain, for that bot only', () => {
    queueBotRevocations(BOT, 'soft', { 'https://host.test:8443': { success: false, error: 'timeout', retry: true } }, T0);
    expect(hasPendingBotRevocation(BOT, 'host.test')).toBe(true);
    expect(hasPendingBotRevocation(BOT, 'https://HOST.test')).toBe(true);
    expect(hasPendingBotRevocation(BOT, 'other.test')).toBe(false);
    expect(hasPendingBotRevocation('bot-2', 'host.test')).toBe(false);
  });
});
