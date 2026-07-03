import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// Mutable references closed over by the vi.mock factories.
let testDb: TestDb;
let testRawDb: Database.Database;
let tmpUploadDir: string;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => testRawDb,
  schema,
}));

vi.mock('../config.js', async () => {
  const real = await import('../config.js');
  return {
    config: new Proxy(real.config, {
      get(target, prop: string) {
        if (prop === 'uploadDir') return tmpUploadDir;
        return (target as Record<string, unknown>)[prop];
      },
    }),
  };
});

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function writeFile(name: string, body: string = 'data'): string {
  const full = path.join(tmpUploadDir, name);
  fs.writeFileSync(full, body);
  return full;
}

function insertDmChannel(opts: {
  id: string;
  icon?: string | null;
  deletedAt?: number | null;
  ownerId?: string | null;
}): void {
  testDb.insert(schema.dmChannels).values({
    id: opts.id,
    ownerId: opts.ownerId ?? 'owner-1',
    federatedId: null,
    ownerHomeUserId: null,
    ownerHomeInstance: null,
    deletedAt: opts.deletedAt ?? null,
    createdAt: Date.now(),
    name: 'Test Group',
    icon: opts.icon ?? null,
    metadataUpdatedAt: 0,
  }).run();
}

function insertAttachment(opts: {
  id: string;
  filename: string;
  size?: number;
  createdAt?: number;
  messageId?: string | null;
  dmMessageId?: string | null;
  thumbnailFilename?: string | null;
}): void {
  testDb.insert(schema.attachments).values({
    id: opts.id,
    messageId: opts.messageId ?? null,
    dmMessageId: opts.dmMessageId ?? null,
    uploaderId: 'user-1',
    filename: opts.filename,
    originalName: opts.filename,
    mimetype: 'image/png',
    size: opts.size ?? 100,
    thumbnailFilename: opts.thumbnailFilename ?? null,
    width: null,
    height: null,
    duration: null,
    sourceUrl: null,
    federationStatus: null,
    // Default: 2h ago — comfortably past the 1h unlinked cutoff
    createdAt: opts.createdAt ?? (Date.now() - 2 * 60 * 60 * 1000),
  } as typeof schema.attachments.$inferInsert).run();
}

beforeEach(() => {
  tmpUploadDir = path.join(os.tmpdir(), `backspace-janitor-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(tmpUploadDir, { recursive: true });

  testRawDb = new Database(':memory:');
  testRawDb.pragma('foreign_keys = ON');
  testDb = drizzle(testRawDb, { schema });
  applyMigrations(testRawDb);
});

afterEach(() => {
  if (fs.existsSync(tmpUploadDir)) {
    fs.rmSync(tmpUploadDir, { recursive: true, force: true });
  }
  try { testRawDb.close(); } catch { /* noop */ }
});

describe('cleanupStorage — dm_channels.icon protection', () => {
  it('preserves a receiver-side dm_channels.icon file (no attachment row)', async () => {
    // Receiver-instance scenario: a federated icon was downloaded directly to
    // disk via downloadProfileAsset — no attachments row ever created. The
    // file is referenced solely by dm_channels.icon. Pre-fix, the janitor's
    // orphan sweep would treat this as orphaned and delete it.
    const { cleanupStorage } = await import('./storageJanitor.js');

    const filename = 'dm-icon-receiver.png';
    writeFile(filename);
    insertDmChannel({ id: 'dm-1', icon: filename });

    const result = cleanupStorage(false);

    expect(fs.existsSync(path.join(tmpUploadDir, filename))).toBe(true);
    expect(result.deletedFiles).toBe(0);
  });

  it('preserves an owner-set dm_channels.icon file (unlinked attachment row + db reference)', async () => {
    // Owner-instance scenario: PATCH /api/dm/:id wrote dm_channels.icon and
    // an attachments row exists with messageId=null AND dmMessageId=null.
    // Past the 1h unlinked grace, the janitor flags it as unlinked. Pre-fix,
    // the file was deleted because dm_channels.icon was not in the
    // profile-referenced set.
    const { cleanupStorage } = await import('./storageJanitor.js');

    const filename = 'dm-icon-owner.png';
    writeFile(filename);
    insertDmChannel({ id: 'dm-2', icon: filename });
    insertAttachment({ id: 'att-1', filename });

    const result = cleanupStorage(false);

    // File must remain — referenced by dm_channels.icon (the bug fix)
    expect(fs.existsSync(path.join(tmpUploadDir, filename))).toBe(true);
    // No bytes freed: file is profile-referenced; attachment row is also
    // skipped by getUnlinkedAttachments (which filters out profile-referenced
    // filenames) so it stays put — same as the avatar precedent. The bytes
    // counter is the load-bearing assertion: pre-fix it would have been > 0
    // because the file would have been deleted as orphaned.
    expect(result.freedBytes).toBe(0);
    expect(result.deletedFiles).toBe(0);
  });

  it('still deletes truly orphaned files (regression check)', async () => {
    const { cleanupStorage } = await import('./storageJanitor.js');

    const filename = 'truly-orphan.png';
    writeFile(filename);
    // No dm_channels.icon, no attachments row — pure orphan.

    const result = cleanupStorage(false);

    expect(fs.existsSync(path.join(tmpUploadDir, filename))).toBe(false);
    expect(result.deletedFiles).toBe(1);
  });

  it('does not protect files referenced by soft-deleted DM channels', async () => {
    // Soft-deleted DMs have their own purge path (cleanupSoftDeletedDmChannels).
    // The icon protection should only apply to live channels — otherwise we
    // leak files for DMs that are pending hard-delete.
    const { cleanupStorage } = await import('./storageJanitor.js');

    const filename = 'soft-deleted-icon.png';
    writeFile(filename);
    insertDmChannel({ id: 'dm-3', icon: filename, deletedAt: Date.now() - 60_000 });

    const result = cleanupStorage(false);

    expect(fs.existsSync(path.join(tmpUploadDir, filename))).toBe(false);
    expect(result.deletedFiles).toBe(1);
  });

  it('does not try to protect remote-URL icons (federated absolute URLs)', async () => {
    // Federated DM icons stored as absolute https:// URLs reference assets on
    // the remote instance. There is no local file to protect, so the janitor
    // must not add the URL string to its referenced-filenames set (which
    // would be a no-op anyway, but confirms the http-skip branch).
    const { cleanupStorage } = await import('./storageJanitor.js');

    insertDmChannel({ id: 'dm-4', icon: 'https://other.example/api/uploads/foo.png' });
    // Drop an unrelated orphan in the upload dir to confirm normal sweep still runs.
    const orphan = 'unrelated-orphan.png';
    writeFile(orphan);

    const result = cleanupStorage(false);

    expect(fs.existsSync(path.join(tmpUploadDir, orphan))).toBe(false);
    expect(result.deletedFiles).toBe(1);
  });
});
