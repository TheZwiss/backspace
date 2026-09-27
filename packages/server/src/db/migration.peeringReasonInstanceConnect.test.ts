import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The data migration that relabels rows the old `POST /api/federation/peer/ensure`
 * wrote. That endpoint recorded every call as `friend_add` with the remote's
 * origin as target, although its only callers were connection flows. The
 * migration turns exactly those rows into `instance_connect` (the target is
 * already in the shape the new code writes: `URL.origin`), and leaves every
 * genuine friend add, whose target is a `name@domain` handle, alone.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const TAG = '0018_peering_reason_instance_connect';

function statementsOf(file: string): string[] {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .split(/-->\s*statement-breakpoint/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function sqlFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
}

/** Everything before the migration under test, so legacy rows can be seeded first. */
function applyUpTo(db: Database.Database, tag: string): void {
  for (const file of sqlFiles()) {
    if (file.startsWith(tag)) return;
    for (const stmt of statementsOf(file)) db.exec(stmt);
  }
  throw new Error(`migration ${tag} not found`);
}

function applyMigrationUnderTest(db: Database.Database): void {
  for (const stmt of statementsOf(`${TAG}.sql`)) db.exec(stmt);
}

let db: Database.Database;

function seedUser(id: string): void {
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(id, id, 'x', 1);
}

function seedRequest(id: string, origin: string): void {
  db.prepare(
    "INSERT INTO peer_approval_requests (id, origin, direction, requested_at, expires_at) VALUES (?, ?, 'outbound', 1, 2)",
  ).run(id, origin);
}

function seedSubscriber(id: string, requestId: string, userId: string, reason: string, target: string, createdAt = 1): void {
  db.prepare(
    'INSERT INTO peer_approval_subscribers (id, request_id, user_id, trigger_reason, trigger_target, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, requestId, userId, reason, target, createdAt);
}

function seedNotification(id: string, userId: string, reason: string, target: string): void {
  db.prepare(
    "INSERT INTO peer_approval_notifications (id, user_id, kind, peer_origin, trigger_reason, trigger_target, created_at) VALUES (?, ?, 'approved', ?, ?, ?, 1)",
  ).run(id, userId, 'https://orbit.example', reason, target);
}

function subscribers(): Array<{ id: string; reason: string; target: string }> {
  return db.prepare('SELECT id, trigger_reason AS reason, trigger_target AS target FROM peer_approval_subscribers ORDER BY id').all() as Array<{ id: string; reason: string; target: string }>;
}

function notifications(): Array<{ id: string; reason: string; target: string }> {
  return db.prepare('SELECT id, trigger_reason AS reason, trigger_target AS target FROM peer_approval_notifications ORDER BY id').all() as Array<{ id: string; reason: string; target: string }>;
}

beforeEach(() => {
  db = new Database(':memory:');
  applyUpTo(db, TAG);
  seedUser('u1');
  seedUser('u2');
  seedRequest('req-orbit', 'https://orbit.example');
  seedRequest('req-local', 'http://localhost:3005');
});

describe(`${TAG}`, () => {
  it('relabels a legacy connection row as instance_connect and keeps its target', () => {
    seedSubscriber('s-legacy', 'req-orbit', 'u1', 'friend_add', 'https://orbit.example');
    seedSubscriber('s-legacy-http', 'req-local', 'u1', 'friend_add', 'http://localhost:3005');
    seedNotification('n-legacy', 'u1', 'friend_add', 'https://orbit.example');

    applyMigrationUnderTest(db);

    expect(subscribers()).toEqual([
      { id: 's-legacy', reason: 'instance_connect', target: 'https://orbit.example' },
      { id: 's-legacy-http', reason: 'instance_connect', target: 'http://localhost:3005' },
    ]);
    expect(notifications()).toEqual([
      { id: 'n-legacy', reason: 'instance_connect', target: 'https://orbit.example' },
    ]);
  });

  it('never touches a genuine friend add, whose target is a handle', () => {
    seedSubscriber('s-friend', 'req-orbit', 'u1', 'friend_add', 'bob@orbit.example');
    seedNotification('n-friend', 'u1', 'friend_add', 'bob@orbit.example');
    // Rows with other reasons are out of scope even when the target looks like an origin.
    seedSubscriber('s-space', 'req-orbit', 'u2', 'space_join', 'https://orbit.example');

    applyMigrationUnderTest(db);

    expect(subscribers()).toEqual([
      { id: 's-friend', reason: 'friend_add', target: 'bob@orbit.example' },
      { id: 's-space', reason: 'space_join', target: 'https://orbit.example' },
    ]);
    expect(notifications()).toEqual([
      { id: 'n-friend', reason: 'friend_add', target: 'bob@orbit.example' },
    ]);
  });

  it('drops a legacy subscriber row whose relabelled twin already exists, rather than failing on the unique key', () => {
    // The same user asked again after the fix: the new row says instance_connect,
    // the old one still says friend_add. Relabelling the old one in place would
    // collide with (request_id, user_id, trigger_reason, trigger_target).
    seedSubscriber('s-old', 'req-orbit', 'u1', 'friend_add', 'https://orbit.example', 1);
    seedSubscriber('s-new', 'req-orbit', 'u1', 'instance_connect', 'https://orbit.example', 5);

    applyMigrationUnderTest(db);

    expect(subscribers()).toEqual([
      { id: 's-new', reason: 'instance_connect', target: 'https://orbit.example' },
    ]);
  });

  it('is idempotent', () => {
    seedSubscriber('s-legacy', 'req-orbit', 'u1', 'friend_add', 'https://orbit.example');
    seedSubscriber('s-friend', 'req-orbit', 'u2', 'friend_add', 'bob@orbit.example');
    seedNotification('n-legacy', 'u1', 'friend_add', 'https://orbit.example');

    applyMigrationUnderTest(db);
    const once = { subscribers: subscribers(), notifications: notifications() };
    applyMigrationUnderTest(db);

    expect({ subscribers: subscribers(), notifications: notifications() }).toEqual(once);
  });

  it('is registered in the journal, so migrate() applies it', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.map(e => e.tag)).toContain(TAG);
  });
});
