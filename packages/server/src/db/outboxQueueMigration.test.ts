import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillOutboxQueueKeys, outboxQueueKey } from '../utils/federationOutboxQueue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, '../../drizzle');
const OUTBOX_QUEUE_MIGRATION = '0021_outbox_queue_keys.sql';

function apply(db: Database.Database, file: string): void {
  const text = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split(/-->\s*statement-breakpoint/)) {
    const clean = stmt.trim();
    if (clean) db.exec(clean);
  }
}

function migrateUpTo(db: Database.Database, stopAt: string): void {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  expect(files).toContain(stopAt);
  for (const f of files) {
    if (f === stopAt) break;
    apply(db, f);
  }
}

function insertPeer(db: Database.Database, id: string, status: string, initiatedBy: string): void {
  db.prepare(
    'INSERT INTO federation_peers (id, origin, hmac_secret, status, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, `https://${id}.example`, 's', status, initiatedBy, 1);
}

function insertRow(db: Database.Database, id: string, peerId: string, eventType: string, contextType: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO federation_outbox (id, peer_id, context_id, entity_id, context_type, event_type, payload, attempts, next_retry_at, expires_at, created_at)
     VALUES (?, ?, 'ctx', ?, ?, ?, '{}', 0, 0, 9999999999999, ?)`,
  ).run(id, peerId, `entity-${id}`, contextType, eventType, createdAt);
}

describe(`migration ${OUTBOX_QUEUE_MIGRATION}`, () => {
  it('marks every queued row as possibly delivered, since nothing recorded whether it was', () => {
    const db = new Database(':memory:');
    migrateUpTo(db, OUTBOX_QUEUE_MIGRATION);
    insertPeer(db, 'active', 'active', 'admin');
    insertRow(db, 'never-attempted', 'active', 'create', 'dm', 100);
    insertRow(db, 'attempted', 'active', 'update', 'dm', 200);
    db.prepare("UPDATE federation_outbox SET attempts = 3 WHERE id = 'attempted'").run();

    apply(db, OUTBOX_QUEUE_MIGRATION);

    expect(db.prepare('SELECT id, offered_at AS offeredAt, queue_key AS queueKey FROM federation_outbox ORDER BY id').all()).toEqual([
      { id: 'attempted', offeredAt: 200, queueKey: null },
      { id: 'never-attempted', offeredAt: 100, queueKey: null },
    ]);
  });

  it('drops presence broadcasts queued on auto-created pending peers, and nothing else', () => {
    const db = new Database(':memory:');
    migrateUpTo(db, OUTBOX_QUEUE_MIGRATION);
    insertPeer(db, 'auto-pending', 'pending', 'auto');
    insertPeer(db, 'admin-pending', 'pending', 'admin');
    insertPeer(db, 'active', 'active', 'auto');
    insertRow(db, 'presence-auto-pending', 'auto-pending', 'presence_update', 'profile', 1);
    insertRow(db, 'profile-auto-pending', 'auto-pending', 'profile_update', 'profile', 2);
    insertRow(db, 'dm-auto-pending', 'auto-pending', 'create', 'dm', 3);
    insertRow(db, 'presence-admin-pending', 'admin-pending', 'presence_update', 'profile', 4);
    insertRow(db, 'presence-active', 'active', 'presence_update', 'profile', 5);

    apply(db, OUTBOX_QUEUE_MIGRATION);

    const ids = (db.prepare('SELECT id FROM federation_outbox ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
    expect(ids).toEqual(['dm-auto-pending', 'presence-active', 'presence-admin-pending', 'profile-auto-pending']);
  });

  it('allows more than one row per peer and entity', () => {
    const db = new Database(':memory:');
    migrateUpTo(db, OUTBOX_QUEUE_MIGRATION);
    apply(db, OUTBOX_QUEUE_MIGRATION);
    insertPeer(db, 'active', 'active', 'admin');
    insertRow(db, 'first', 'active', 'create', 'dm', 1);
    db.prepare(
      `INSERT INTO federation_outbox (id, peer_id, context_id, entity_id, context_type, event_type, payload, attempts, next_retry_at, expires_at, created_at)
       VALUES ('second', 'active', 'ctx', 'entity-first', 'dm', 'update', '{}', 0, 0, 9999999999999, 2)`,
    ).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM federation_outbox').get()).toEqual({ n: 2 });
  });
});

describe('backfillOutboxQueueKeys', () => {
  it('gives every row without a queue key the key its event would get today, and is a no-op after', () => {
    const db = new Database(':memory:');
    for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) apply(db, f);
    insertPeer(db, 'active', 'active', 'admin');
    insertRow(db, 'dana-presence', 'active', 'presence_update', 'profile', 1);
    db.prepare("UPDATE federation_outbox SET entity_id = 'dana' WHERE id = 'dana-presence'").run();
    insertRow(db, 'keyed', 'active', 'create', 'dm', 2);
    db.prepare("UPDATE federation_outbox SET queue_key = 'message:kept' WHERE id = 'keyed'").run();

    expect(backfillOutboxQueueKeys(db)).toBe(1);
    expect(backfillOutboxQueueKeys(db)).toBe(0);

    expect(db.prepare('SELECT id, queue_key AS queueKey FROM federation_outbox ORDER BY id').all()).toEqual([
      { id: 'dana-presence', queueKey: outboxQueueKey('presence_update', 'dana', 'ctx', '{}') },
      { id: 'keyed', queueKey: 'message:kept' },
    ]);
  });
});
