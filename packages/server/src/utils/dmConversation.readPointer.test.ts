import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setWorkerId } from './snowflake.js';
import { backfillOneOnOneKeys, findOrCreateOneOnOne, oneOnOneKey, type HomeIdentified } from './dmConversation.js';

setWorkerId(3);

/**
 * When a person's membership moves between rows (a merge of two 1-on-1 rows)
 * or between local ids (one row per person, the pair's local ids), their read
 * pointer moves with it, and where two pointers meet the newer one is kept
 * (`keepNewerReadPointer`). Keeping the older one showed messages the person
 * had read as unread once.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sqlite: Database.Database;

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

function seedUser(id: string, homeUserId: string | null = null, homeInstance: string | null = null): HomeIdentified {
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, home_user_id, home_instance, created_at) VALUES (?, ?, 'h', ?, ?, 1)`)
    .run(id, `${id}@x`, homeUserId, homeInstance);
  return { id, homeUserId };
}
function seedChannel(id: string, fedId: string | null, members: string[], createdAt = 1): void {
  sqlite.prepare(`INSERT INTO dm_channels (id, owner_id, federated_id, created_at) VALUES (?, NULL, ?, ?)`).run(id, fedId, createdAt);
  for (const u of members) sqlite.prepare(`INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?, ?, 0)`).run(id, u);
}
function seedRead(userId: string, channelId: string, lastReadMessageId: string): void {
  sqlite.prepare(`INSERT INTO read_states (user_id, channel_id, last_read_message_id, updated_at) VALUES (?, ?, ?, 1)`)
    .run(userId, channelId, lastReadMessageId);
}
function readStates(): Array<{ userId: string; channelId: string; last: string }> {
  return sqlite.prepare(`SELECT user_id AS userId, channel_id AS channelId, last_read_message_id AS last FROM read_states ORDER BY user_id, channel_id`)
    .all() as Array<{ userId: string; channelId: string; last: string }>;
}

// Snowflake ids compare as numbers: '900' is older than '1000' though it sorts after it as text.
const OLDER = '900';
const NEWER = '1000';

let alice: HomeIdentified;
let bob: HomeIdentified;

beforeEach(() => {
  sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  alice = seedUser('alice');
  bob = seedUser('bob', 'bob-home', 'orbit.test');
});

describe('merging one 1-on-1 row into another', () => {
  it('keeps the merged-away row\'s pointer when it is the newer one', () => {
    seedChannel('target', oneOnOneKey(alice, bob), ['alice', 'bob']);
    seedChannel('merged', null, ['alice', 'bob'], 2);
    seedRead('alice', 'target', OLDER);
    seedRead('alice', 'merged', NEWER);
    backfillOneOnOneKeys(sqlite);
    expect(readStates()).toEqual([{ userId: 'alice', channelId: 'target', last: NEWER }]);
  });

  it('keeps the target\'s pointer when it is the newer one', () => {
    seedChannel('target', oneOnOneKey(alice, bob), ['alice', 'bob']);
    seedChannel('merged', null, ['alice', 'bob'], 2);
    seedRead('alice', 'target', NEWER);
    seedRead('alice', 'merged', OLDER);
    backfillOneOnOneKeys(sqlite);
    expect(readStates()).toEqual([{ userId: 'alice', channelId: 'target', last: NEWER }]);
  });

  it('moves the pointer of a member the target holds under another local id to that id', () => {
    seedUser('bob-2', 'bob-home', 'orbit.test');
    seedChannel('target', oneOnOneKey(alice, bob), ['alice', 'bob']);
    seedChannel('merged', null, ['alice', 'bob-2'], 2);
    seedRead('bob', 'target', OLDER);
    seedRead('bob-2', 'merged', NEWER);
    backfillOneOnOneKeys(sqlite);
    expect(readStates()).toEqual([{ userId: 'bob', channelId: 'target', last: NEWER }]);
  });
});

describe('findOrCreateOneOnOne on a row with a person under two local ids', () => {
  it('keeps the newer pointer on the local id it keeps', () => {
    seedUser('bob-2', 'bob-home', 'orbit.test');
    seedChannel('ch', oneOnOneKey(alice, bob), ['alice', 'bob', 'bob-2']);
    seedRead('bob', 'ch', OLDER);
    seedRead('bob-2', 'ch', NEWER);
    findOrCreateOneOnOne({ $client: sqlite }, alice, bob, { open: 'both' });
    expect(readStates()).toEqual([{ userId: 'bob', channelId: 'ch', last: NEWER }]);
  });

  it('moves the pointer with a membership re-pointed to the pair\'s local id', () => {
    seedUser('bob-2', 'bob-home', 'orbit.test');
    seedChannel('ch', oneOnOneKey(alice, bob), ['alice', 'bob-2']);
    seedRead('bob-2', 'ch', NEWER);
    findOrCreateOneOnOne({ $client: sqlite }, alice, bob, { open: 'both' });
    expect(readStates()).toEqual([{ userId: 'bob', channelId: 'ch', last: NEWER }]);
  });
});
