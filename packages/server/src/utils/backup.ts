import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../config.js';

export type SnapshotReason = 'pre-migration' | 'scheduled' | 'manual';

export interface SnapshotInfo {
  path: string;
  reason: SnapshotReason;
  bytes: number;
  mtimeMs: number;
}

const REASONS: SnapshotReason[] = ['pre-migration', 'scheduled', 'manual'];

function ensureDir(): string {
  fs.mkdirSync(config.backup.dir, { recursive: true });
  return config.backup.dir;
}

function timestamp(): string {
  // 2026-06-20T14:03:09.123Z -> 20260620T140309123 (ms precision keeps names unique
  // and sortable; VACUUM INTO throws if the target file already exists).
  return new Date().toISOString().replace(/[-:.]/g, '').replace(/Z$/, '');
}

/** Synchronous, WAL-safe snapshot via VACUUM INTO. Returns the absolute path. */
export function createSnapshot(db: Database.Database, reason: SnapshotReason): string {
  const dir = ensureDir();
  const ts = timestamp();
  // VACUUM INTO throws if the target already exists. Millisecond precision keeps
  // names unique under normal use, but tight loops can collide within the same
  // millisecond — append a disambiguating counter on collision to guarantee a
  // free, sortable path.
  let file = path.join(dir, `backspace-${ts}-${reason}.db`);
  for (let n = 1; fs.existsSync(file); n++) {
    file = path.join(dir, `backspace-${ts}-${String(n).padStart(3, '0')}-${reason}.db`);
  }
  db.prepare('VACUUM INTO ?').run(file);
  runOffsite(file);
  return file;
}

function runOffsite(snapshotPath: string): void {
  const cmd = config.backup.offsiteCmd;
  if (!cmd) return;
  // Best-effort: failures are logged, never fatal.
  execFile('/bin/sh', ['-c', `${cmd} "$1"`, 'sh', snapshotPath], (err, _stdout, stderr) => {
    if (err) console.error(`[backup] off-box hook failed: ${err.message} ${stderr ?? ''}`);
  });
}

export function listSnapshots(): SnapshotInfo[] {
  if (!fs.existsSync(config.backup.dir)) return [];
  return fs.readdirSync(config.backup.dir)
    .filter(f => f.endsWith('.db'))
    .map((f): SnapshotInfo | null => {
      const reason = REASONS.find(r => f.endsWith(`-${r}.db`));
      if (!reason) return null;
      const full = path.join(config.backup.dir, f);
      const st = fs.statSync(full);
      return { path: full, reason, bytes: st.size, mtimeMs: st.mtimeMs };
    })
    .filter((s): s is SnapshotInfo => s !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function pruneSnapshots(): void {
  const keep: Record<SnapshotReason, number> = {
    'pre-migration': config.backup.keepPreMigration,
    scheduled: config.backup.keepScheduled,
    manual: config.backup.keepManual,
  };
  for (const reason of REASONS) {
    const ofReason = listSnapshots().filter(s => s.reason === reason); // newest-first
    for (const stale of ofReason.slice(keep[reason])) {
      try { fs.unlinkSync(stale.path); } catch (err) {
        console.error(`[backup] failed to prune ${stale.path}: ${(err as Error).message}`);
      }
    }
  }
}
