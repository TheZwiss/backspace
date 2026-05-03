import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateUserData } from './userDataMigration';

let tmpRoot: string;
let oldParent: string;
let oldDir: string;
let newDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-migration-'));
  oldParent = path.join(tmpRoot, '@backspace');
  oldDir = path.join(oldParent, 'desktop');
  newDir = path.join(tmpRoot, 'Backspace');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedOld(): void {
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'instance-url.json'), '{"url":"https://nova.ddns.net"}');
  fs.mkdirSync(path.join(oldDir, 'IndexedDB'));
  fs.writeFileSync(path.join(oldDir, 'IndexedDB', 'leveldb.log'), 'data');
}

describe('migrateUserData', () => {
  it('returns no-op when oldDir does not exist', () => {
    const result = migrateUserData({ oldDir, newDir, oldParent });
    expect(result).toEqual({ kind: 'no-op', reason: 'old-missing' });
    expect(fs.existsSync(newDir)).toBe(false);
  });

  it('returns no-op:identical when oldDir === newDir', () => {
    fs.mkdirSync(oldDir, { recursive: true });
    const result = migrateUserData({ oldDir, newDir: oldDir, oldParent });
    expect(result).toEqual({ kind: 'no-op', reason: 'identical' });
  });

  it('migrates and cleans empty parent when newDir is absent', () => {
    seedOld();
    const result = migrateUserData({ oldDir, newDir, oldParent });
    expect(result).toEqual({ kind: 'migrated', from: oldDir, to: newDir });
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(oldParent)).toBe(false);
    expect(fs.readFileSync(path.join(newDir, 'instance-url.json'), 'utf-8'))
      .toBe('{"url":"https://nova.ddns.net"}');
    expect(fs.existsSync(path.join(newDir, 'IndexedDB', 'leveldb.log'))).toBe(true);
  });

  it('migrates when newDir exists but is empty', () => {
    seedOld();
    fs.mkdirSync(newDir);
    const result = migrateUserData({ oldDir, newDir, oldParent });
    expect(result.kind).toBe('migrated');
    expect(fs.readFileSync(path.join(newDir, 'instance-url.json'), 'utf-8'))
      .toBe('{"url":"https://nova.ddns.net"}');
  });

  it('returns no-op:new-populated and leaves both folders intact', () => {
    seedOld();
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(newDir, 'preexisting.json'), '{}');
    const result = migrateUserData({ oldDir, newDir, oldParent });
    expect(result).toEqual({ kind: 'no-op', reason: 'new-populated' });
    expect(fs.existsSync(path.join(oldDir, 'instance-url.json'))).toBe(true);
    expect(fs.existsSync(path.join(newDir, 'preexisting.json'))).toBe(true);
  });

  it('preserves oldParent when it has sibling subdirectories', () => {
    seedOld();
    fs.mkdirSync(path.join(oldParent, 'other-pkg'));
    fs.writeFileSync(path.join(oldParent, 'other-pkg', 'state.json'), '{}');
    const result = migrateUserData({ oldDir, newDir, oldParent });
    expect(result.kind).toBe('migrated');
    expect(fs.existsSync(oldParent)).toBe(true);
    expect(fs.existsSync(path.join(oldParent, 'other-pkg', 'state.json'))).toBe(true);
  });
});
