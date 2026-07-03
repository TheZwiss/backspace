import fs from 'fs';
import path from 'path';

export type MigrationResult =
  | { kind: 'no-op'; reason: 'old-missing' | 'new-populated' | 'identical' }
  | { kind: 'migrated'; from: string; to: string }
  | { kind: 'failed'; error: Error };

export interface MigrationOptions {
  oldDir: string;
  newDir: string;
  oldParent: string;
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isEmpty(dir: string): boolean {
  return fs.readdirSync(dir).length === 0;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

export function migrateUserData(opts: MigrationOptions): MigrationResult {
  const { oldDir, newDir, oldParent } = opts;

  try {
    if (path.resolve(oldDir) === path.resolve(newDir)) {
      return { kind: 'no-op', reason: 'identical' };
    }
    if (!dirExists(oldDir)) {
      return { kind: 'no-op', reason: 'old-missing' };
    }
    if (dirExists(newDir)) {
      if (!isEmpty(newDir)) {
        return { kind: 'no-op', reason: 'new-populated' };
      }
      fs.rmdirSync(newDir);
    }

    fs.mkdirSync(path.dirname(newDir), { recursive: true });

    try {
      fs.renameSync(oldDir, newDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      copyDirRecursive(oldDir, newDir);
      fs.rmSync(oldDir, { recursive: true, force: true });
    }

    try {
      fs.rmdirSync(oldParent);
    } catch {
      // Parent has other children, or doesn't exist — both fine.
    }

    return { kind: 'migrated', from: oldDir, to: newDir };
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err : new Error(String(err)) };
  }
}
