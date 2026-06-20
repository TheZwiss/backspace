import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;

vi.mock('../config.js', () => ({
  config: {
    backup: {
      get dir() { return tmpDir; },
      intervalHours: 24, keepScheduled: 2, keepPreMigration: 2, keepManual: 2,
      offsiteCmd: undefined, disabled: false,
    },
  },
}));

import { createSnapshot, pruneSnapshots, listSnapshots } from './backup.js';

function seededDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('a');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('b');
  return db;
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('createSnapshot', () => {
  it('writes a valid standalone DB with identical rows', () => {
    const db = seededDb();
    const out = createSnapshot(db, 'manual');
    expect(fs.existsSync(out)).toBe(true);
    const copy = new Database(out, { readonly: true });
    const n = (copy.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
    expect(n).toBe(2);
    copy.close();
  });

  it('encodes the reason in the filename', () => {
    const db = seededDb();
    const out = createSnapshot(db, 'pre-migration');
    expect(path.basename(out)).toMatch(/pre-migration\.db$/);
  });
});

describe('pruneSnapshots', () => {
  it('keeps only keep<Reason> newest per reason', () => {
    const db = seededDb();
    for (let i = 0; i < 4; i++) {
      // unique names: createSnapshot uses a timestamp; force distinct mtimes
      const p = createSnapshot(db, 'manual');
      fs.utimesSync(p, new Date(1000 + i), new Date(1000 + i));
    }
    pruneSnapshots();
    const remaining = listSnapshots().filter(s => s.reason === 'manual');
    expect(remaining.length).toBe(2); // keepManual = 2
  });
});
