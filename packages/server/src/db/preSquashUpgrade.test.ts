import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outboxQueueKey } from '../utils/federationOutboxQueue.js';

/**
 * Upgrades through the real boot path (`initDatabase`: Drizzle's migrator,
 * then the boot backfills) from each database shape found in the field:
 *
 * - pre-squash: an instance created before the migration history was squashed
 *   into 0000. Its tables come from the old hand-written statements
 *   (test/fixtures/pre-squash-schema.sql) and its history records 0000-0020.
 * - squashed: an install that ran 0000-0020 itself.
 * - empty: a first boot.
 *
 * A migration that only works on the shape 0000 creates crash-loops every
 * pre-squash instance at boot; this is the guard against that.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, '../../drizzle');
const PRE_SQUASH_FIXTURE = path.resolve(__dirname, '../../test/fixtures/pre-squash-schema.sql');
const FIRST_UNAPPLIED = '0021_outbox_queue_keys';

interface JournalEntry { idx: number; when: number; tag: string }
interface SnapshotColumn { name: string; type: string; primaryKey: boolean; notNull: boolean; default?: string | number }
interface SnapshotTable {
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, { name: string; columns: string[]; isUnique: boolean }>;
  foreignKeys: Record<string, { tableTo: string; columnsFrom: string[]; columnsTo: string[]; onDelete: string; onUpdate: string }>;
}
interface TableInfoRow { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

const journal = (JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }).entries;

function migrationText(tag: string): string {
  return fs.readFileSync(path.join(MIGRATIONS, `${tag}.sql`), 'utf8');
}

/** The entries before `FIRST_UNAPPLIED`: what both upgrade shapes have applied. */
function appliedEntries(): JournalEntry[] {
  const stop = journal.findIndex((e) => e.tag === FIRST_UNAPPLIED);
  expect(stop).toBeGreaterThan(0);
  return journal.slice(0, stop);
}

/**
 * Records `entries` as applied the way Drizzle's migrator does: the sha256 of
 * the file and the journal's `when` as created_at. The pre-squash instance's
 * history holds exactly these hashes and timestamps; only its row ids differ
 * (its earliest rows were removed), which the migrator never reads.
 */
function recordApplied(db: Database.Database, entries: JournalEntry[]): void {
  db.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "hash" text NOT NULL, "created_at" numeric)');
  const insert = db.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)');
  for (const e of entries) {
    insert.run(crypto.createHash('sha256').update(migrationText(e.tag)).digest('hex'), e.when);
  }
}

function buildPreSquash(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(PRE_SQUASH_FIXTURE, 'utf8'));
  recordApplied(db, appliedEntries());
  db.close();
}

function buildSquashed(dbPath: string): void {
  const db = new Database(dbPath);
  const entries = appliedEntries();
  for (const e of entries) {
    for (const stmt of migrationText(e.tag).split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
  recordApplied(db, entries);
  db.close();
}

const PEERS = [
  { id: 'peer-active', status: 'active', initiatedBy: 'admin' },
  { id: 'peer-auto-pending', status: 'pending', initiatedBy: 'auto' },
] as const;

/** Outbox rows queued before 0021, as the old code would have left them. */
const SEEDED = [
  { id: 'row-create', peerId: 'peer-active', entityId: 'msg-1', eventType: 'create', contextType: 'dm', attempts: 0, createdAt: 100 },
  { id: 'row-update', peerId: 'peer-active', entityId: 'msg-2', eventType: 'update', contextType: 'dm', attempts: 4, createdAt: 200 },
  { id: 'row-presence-active', peerId: 'peer-active', entityId: 'user-1', eventType: 'presence_update', contextType: 'profile', attempts: 0, createdAt: 300 },
  { id: 'row-presence-auto-pending', peerId: 'peer-auto-pending', entityId: 'user-1', eventType: 'presence_update', contextType: 'profile', attempts: 0, createdAt: 400 },
  { id: 'row-profile-auto-pending', peerId: 'peer-auto-pending', entityId: 'user-2', eventType: 'profile_update', contextType: 'profile', attempts: 0, createdAt: 500 },
  { id: 'row-orphan', peerId: 'peer-deleted', entityId: 'msg-3', eventType: 'create', contextType: 'dm', attempts: 0, createdAt: 600 },
] as const;

/** Rows the upgrade keeps: everything but the auto-pending presence and the orphan. */
const KEPT = SEEDED.filter((r) => r.id !== 'row-presence-auto-pending' && r.id !== 'row-orphan');

function seed(dbPath: string): void {
  const db = new Database(dbPath);
  const peer = db.prepare('INSERT INTO federation_peers (id, origin, hmac_secret, status, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, 1)');
  for (const p of PEERS) peer.run(p.id, `https://${p.id}.example`, 'secret', p.status, p.initiatedBy);
  // The orphan is a row whose peer was deleted while foreign keys were off.
  db.pragma('foreign_keys = OFF');
  const row = db.prepare(
    `INSERT INTO federation_outbox (id, peer_id, context_id, entity_id, context_type, event_type, payload, encryption_version, attempts, next_retry_at, expires_at, created_at)
     VALUES (?, ?, 'ctx', ?, ?, ?, '{}', 1, ?, 7, 9999999999999, ?)`,
  );
  for (const r of SEEDED) row.run(r.id, r.peerId, r.entityId, r.contextType, r.eventType, r.attempts, r.createdAt);
  db.close();
}

/** Boots the server's database layer on `dbPath`, exactly as the server does. */
async function boot(dbPath: string): Promise<void> {
  vi.resetModules();
  process.env.DB_PATH = dbPath;
  process.env.BACKUP_DISABLED = 'true';
  const { initDatabase, closeDatabase } = await import('./index.js');
  try {
    initDatabase();
  } finally {
    closeDatabase();
  }
}

/** The outbox's schema objects as SQLite stores them. */
function outboxSchema(db: Database.Database): Array<{ type: string; name: string; sql: string | null }> {
  return db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'federation_outbox' ORDER BY type, name",
  ).all() as Array<{ type: string; name: string; sql: string | null }>;
}

function loadOutboxSnapshot(): SnapshotTable {
  const file = path.join(MIGRATIONS, 'meta', `${FIRST_UNAPPLIED.slice(0, 4)}_snapshot.json`);
  const table = (JSON.parse(fs.readFileSync(file, 'utf8')) as { tables: Record<string, SnapshotTable | undefined> }).tables.federation_outbox;
  if (!table) throw new Error(`${file} has no federation_outbox table`);
  return table;
}

const snapshot = loadOutboxSnapshot();

/** Asserts the outbox is the table drizzle-kit's snapshot (and so schema.ts) describes. */
function expectSnapshotShape(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(federation_outbox)').all() as TableInfoRow[];
  expect(columns.map((c) => ({
    name: c.name,
    type: c.type.toLowerCase(),
    primaryKey: c.pk === 1,
    notNull: c.notnull === 1 || c.pk === 1,
    default: c.dflt_value ?? undefined,
  }))).toEqual(Object.values(snapshot.columns).map((c) => ({
    name: c.name,
    type: c.type,
    primaryKey: c.primaryKey,
    notNull: c.notNull,
    default: c.default === undefined ? undefined : String(c.default),
  })));

  const indexes = (db.prepare('PRAGMA index_list(federation_outbox)').all() as Array<{ name: string; unique: number; origin: string }>)
    .filter((i) => i.origin === 'c')
    .map((i) => ({
      name: i.name,
      columns: (db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all() as Array<{ name: string }>).map((c) => c.name),
      isUnique: i.unique === 1,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(indexes).toEqual(Object.values(snapshot.indexes).sort((a, b) => a.name.localeCompare(b.name)));

  // The only uniqueness left is the primary key's; no (peer_id, entity_id)
  // constraint in either of its forms survives.
  const implicit = (db.prepare('PRAGMA index_list(federation_outbox)').all() as Array<{ origin: string }>).map((i) => i.origin).filter((o) => o !== 'c');
  expect(implicit).toEqual(['pk']);

  const fks = db.prepare('PRAGMA foreign_key_list(federation_outbox)').all() as Array<{ table: string; from: string; to: string; on_delete: string; on_update: string }>;
  expect(fks.map((f) => ({
    tableTo: f.table,
    columnsFrom: [f.from],
    columnsTo: [f.to],
    onDelete: f.on_delete.toLowerCase(),
    onUpdate: f.on_update.toLowerCase(),
  }))).toEqual(Object.values(snapshot.foreignKeys).map((f) => ({
    tableTo: f.tableTo,
    columnsFrom: f.columnsFrom,
    columnsTo: f.columnsTo,
    onDelete: f.onDelete,
    onUpdate: f.onUpdate,
  })));
}

describe('upgrading through initDatabase from every database shape in the field', () => {
  let dir: string;
  const shapes: Record<'preSquash' | 'squashed' | 'empty', string> = { preSquash: '', squashed: '', empty: '' };
  const savedEnv = { DB_PATH: process.env.DB_PATH, BACKUP_DISABLED: process.env.BACKUP_DISABLED };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-pre-squash-'));
    shapes.preSquash = path.join(dir, 'pre-squash.db');
    shapes.squashed = path.join(dir, 'squashed.db');
    shapes.empty = path.join(dir, 'empty.db');

    buildPreSquash(shapes.preSquash);
    seed(shapes.preSquash);
    buildSquashed(shapes.squashed);
    seed(shapes.squashed);

    for (const dbPath of Object.values(shapes)) await boot(dbPath);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the pre-squash fixture really has the inline (peer_id, entity_id) constraint DROP INDEX cannot remove', () => {
    const db = new Database(':memory:');
    db.exec(fs.readFileSync(PRE_SQUASH_FIXTURE, 'utf8'));
    const indexes = db.prepare('PRAGMA index_list(federation_outbox)').all() as Array<{ name: string; origin: string }>;
    expect(indexes.filter((i) => i.origin === 'u').map((i) => i.name)).toEqual(['sqlite_autoindex_federation_outbox_2']);
    expect(indexes.map((i) => i.name)).not.toContain('federation_outbox_peer_id_entity_id_unique');
    db.close();
  });

  it.each(['preSquash', 'squashed', 'empty'] as const)('%s: records every migration as applied', (shape) => {
    const db = new Database(shapes[shape], { readonly: true });
    const latest = db.prepare('SELECT created_at AS createdAt FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1').get() as { createdAt: number };
    expect(Number(latest.createdAt)).toBe(journal.at(-1)?.when);
    db.close();
  });

  it.each(['preSquash', 'squashed', 'empty'] as const)('%s: leaves the outbox in the shape the 0021 snapshot describes', (shape) => {
    const db = new Database(shapes[shape], { readonly: true });
    expectSnapshotShape(db);
    db.close();
  });

  it('every shape ends with the identical outbox definition', () => {
    const [preSquash, squashed, empty] = (['preSquash', 'squashed', 'empty'] as const).map((shape) => {
      const db = new Database(shapes[shape], { readonly: true });
      const schema = outboxSchema(db);
      db.close();
      return schema;
    });
    expect(preSquash).toEqual(squashed);
    expect(empty).toEqual(squashed);
  });

  it.each(['preSquash', 'squashed'] as const)('%s: keeps the queued rows, marks them offered and keys them', (shape) => {
    const db = new Database(shapes[shape], { readonly: true });
    const rows = db.prepare(
      `SELECT id, peer_id AS peerId, entity_id AS entityId, context_type AS contextType, event_type AS eventType, payload,
              encryption_version AS encryptionVersion, attempts, next_retry_at AS nextRetryAt, expires_at AS expiresAt,
              created_at AS createdAt, offered_at AS offeredAt, queue_key AS queueKey
       FROM federation_outbox ORDER BY created_at`,
    ).all();
    expect(rows).toEqual(KEPT.map((r) => ({
      id: r.id,
      peerId: r.peerId,
      entityId: r.entityId,
      contextType: r.contextType,
      eventType: r.eventType,
      payload: '{}',
      encryptionVersion: 1,
      attempts: r.attempts,
      nextRetryAt: 7,
      expiresAt: 9999999999999,
      createdAt: r.createdAt,
      offeredAt: r.createdAt,
      queueKey: outboxQueueKey(r.eventType, r.entityId, 'ctx', '{}'),
    })));
    expect(db.prepare('PRAGMA foreign_key_check(federation_outbox)').all()).toEqual([]);
    db.close();
  });

  it.each(['preSquash', 'squashed', 'empty'] as const)('%s: queues more than one row per peer and entity, and still cascades from the peer', (shape) => {
    const db = new Database(shapes[shape]);
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT OR IGNORE INTO federation_peers (id, origin, hmac_secret, created_at) VALUES ('peer-extra', 'https://peer-extra.example', 'secret', 1)").run();
    const row = db.prepare(
      `INSERT INTO federation_outbox (id, peer_id, context_id, entity_id, queue_key, event_type, payload, next_retry_at, expires_at, created_at)
       VALUES (?, 'peer-extra', 'ctx', 'msg-x', 'message:msg-x', ?, '{}', 0, 1, ?)`,
    );
    row.run('extra-1', 'create', 1);
    row.run('extra-2', 'update', 2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM federation_outbox WHERE peer_id = 'peer-extra'").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT context_type AS contextType, attempts, encryption_version AS encryptionVersion, offered_at AS offeredAt FROM federation_outbox WHERE id = 'extra-1'").get())
      .toEqual({ contextType: 'dm', attempts: 0, encryptionVersion: 0, offeredAt: null });

    db.prepare("DELETE FROM federation_peers WHERE id = 'peer-extra'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM federation_outbox WHERE peer_id = 'peer-extra'").get()).toEqual({ n: 0 });
    db.close();
  });
});
