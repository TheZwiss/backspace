import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';
import type { DmReconcileResult } from './dmConversation.js';

setWorkerId(3);

/**
 * `announceDmReconcile`: after a 1-on-1 row is re-keyed or merged, each local
 * member's DM list is told once. A merged-away row is closed for everyone who
 * had it; the surviving row is sent only to members who have it open, so a
 * conversation someone closed does not come back to their list.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('../db/index.js', () => ({
  getDb: () => db,
  getRawDb: () => sqlite,
  schema,
}));

const sent: Array<{ userId: string; event: { type: string; dmChannelId?: string; dmChannel?: { id: string } } }> = [];
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: (userId: string, event: { type: string }) => { sent.push({ userId, event }); },
  },
}));

function applyMigrations(target: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) target.exec(clean);
    }
  }
}

function seedUser(id: string): void {
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'h', 1)`).run(id, id);
}

function summary(): string[] {
  return sent.map(s => `${s.userId} ${s.event.type} ${s.event.dmChannelId ?? s.event.dmChannel?.id ?? ''}`).sort();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  sent.length = 0;
  seedUser('alice');
  seedUser('bob');
  sqlite.prepare(`INSERT INTO dm_channels (id, owner_id, federated_id, created_at) VALUES ('target', NULL, 'k', 1)`).run();
});

function members(open: Record<string, 0 | 1>): void {
  for (const [userId, closed] of Object.entries(open)) {
    sqlite.prepare(`INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES ('target', ?, ?)`).run(userId, closed);
  }
}

describe('announceDmReconcile', () => {
  it('a merge: closes the merged-away row for every affected member, sends the target to open members only', async () => {
    members({ alice: 0, bob: 1 });
    const { announceDmReconcile } = await import('./dmConversationEvents.js');
    const results: DmReconcileResult[] = [
      { action: 'merged', channelId: 'gone', targetChannelId: 'target', affectedUserIds: ['alice', 'bob'] },
    ];
    announceDmReconcile(results);
    expect(summary()).toEqual([
      'alice dm_channel_closed gone',
      'alice dm_channel_created target',
      'bob dm_channel_closed gone',
    ]);
  });

  it('a re-key: sends the row to open members only', async () => {
    members({ alice: 1, bob: 0 });
    const { announceDmReconcile } = await import('./dmConversationEvents.js');
    announceDmReconcile([{ action: 'rekeyed', channelId: 'target', targetChannelId: 'target', affectedUserIds: ['alice', 'bob'] }]);
    expect(summary()).toEqual(['bob dm_channel_created target']);
  });

  it('a noop tells no one', async () => {
    members({ alice: 0, bob: 0 });
    const { announceDmReconcile } = await import('./dmConversationEvents.js');
    announceDmReconcile([{ action: 'noop', channelId: 'target', targetChannelId: 'target', affectedUserIds: [] }]);
    expect(sent).toEqual([]);
  });
});
