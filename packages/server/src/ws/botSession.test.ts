import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

/**
 * One live socket per bot credential (bots.md, "One process per token"): the
 * ConnectionManager side of the rule. The auth path that calls it is covered
 * end to end in test/federation-e2e-bots.test.ts.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

async function load() {
  const { connectionManager } = await import('./handler.js');
  return connectionManager;
}

const socket = (readyState = 1) => ({ readyState, send: vi.fn() }) as unknown as WebSocket;

beforeEach(() => {
  // connectionManager is a module singleton: a fresh copy per test.
  vi.resetModules();
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
});

describe('claimBotSession', () => {
  it('refuses a second open socket for the same token, and lets the first keep it', async () => {
    const cm = await load();
    const first = socket();
    const second = socket();
    expect(cm.claimBotSession('token:aa', first)).toBe(true);
    expect(cm.claimBotSession('token:aa', second)).toBe(false);
    // The holder can claim again (idempotent), the refused one still cannot.
    expect(cm.claimBotSession('token:aa', first)).toBe(true);
    expect(cm.claimBotSession('token:aa', second)).toBe(false);
  });

  it('keeps tokens apart: another token of the same bot is its own credential', async () => {
    const cm = await load();
    expect(cm.claimBotSession('token:aa', socket())).toBe(true);
    expect(cm.claimBotSession('token:bb', socket())).toBe(true);
    expect(cm.claimBotSession('account:bot-1', socket())).toBe(true);
  });

  it('frees the credential when the holding socket is removed', async () => {
    // removeConnection starts the 5 s offline grace; fake timers keep it from firing.
    vi.useFakeTimers();
    try {
      const cm = await load();
      const first = socket();
      cm.addConnection('bot-1', first);
      expect(cm.claimBotSession('token:aa', first)).toBe(true);
      cm.removeConnection(first);
      expect(cm.claimBotSession('token:aa', socket())).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('replaces a holder that is already closing or closed', async () => {
    const cm = await load();
    const closing = socket(2);
    expect(cm.claimBotSession('token:aa', closing)).toBe(true);
    const next = socket();
    expect(cm.claimBotSession('token:aa', next)).toBe(true);
    // The replaced socket's late close must not free the new holder.
    cm.releaseBotSession(closing);
    expect(cm.claimBotSession('token:aa', socket())).toBe(false);
  });
});
