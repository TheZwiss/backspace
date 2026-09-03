import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseUpdaterCacheDirName,
  isSafeUpdaterCacheDirName,
  resolveUpdaterCacheDir,
  purgeUpdaterCache,
} from './updaterCache';

describe('parseUpdaterCacheDirName', () => {
  it('reads the real app-update.yml electron-builder emits', () => {
    // Verbatim from /Applications/Backspace.app/Contents/Resources/app-update.yml
    const yml = [
      'owner: TheZwiss',
      'repo: backspace',
      'provider: github',
      "updaterCacheDirName: '@backspacedesktop-updater'",
      '',
    ].join('\n');
    expect(parseUpdaterCacheDirName(yml)).toBe('@backspacedesktop-updater');
  });

  it('handles double quotes and bare scalars', () => {
    expect(parseUpdaterCacheDirName('updaterCacheDirName: "app-updater"')).toBe('app-updater');
    expect(parseUpdaterCacheDirName('updaterCacheDirName: app-updater')).toBe('app-updater');
  });

  it('strips an inline comment from an unquoted scalar', () => {
    expect(parseUpdaterCacheDirName('updaterCacheDirName: app-updater # generated'))
      .toBe('app-updater');
  });

  it('ignores commented-out lines', () => {
    const yml = ['# updaterCacheDirName: wrong-updater', 'updaterCacheDirName: right-updater'].join('\n');
    expect(parseUpdaterCacheDirName(yml)).toBe('right-updater');
  });

  it('returns null when the key is absent or empty', () => {
    expect(parseUpdaterCacheDirName('provider: github')).toBeNull();
    expect(parseUpdaterCacheDirName('')).toBeNull();
    expect(parseUpdaterCacheDirName('updaterCacheDirName:')).toBeNull();
    expect(parseUpdaterCacheDirName("updaterCacheDirName: ''")).toBeNull();
  });
});

describe('isSafeUpdaterCacheDirName', () => {
  it('accepts the real name', () => {
    expect(isSafeUpdaterCacheDirName('@backspacedesktop-updater')).toBe(true);
  });

  it('requires the -updater suffix, so no unrelated directory qualifies', () => {
    expect(isSafeUpdaterCacheDirName('Backspace')).toBe(false);
    expect(isSafeUpdaterCacheDirName('com.apple.Safari')).toBe(false);
    expect(isSafeUpdaterCacheDirName('@backspacedesktop-updater-old')).toBe(false);
  });

  it('rejects anything containing a path separator or traversal', () => {
    expect(isSafeUpdaterCacheDirName('../../-updater')).toBe(false);
    expect(isSafeUpdaterCacheDirName('..-updater')).toBe(false);
    expect(isSafeUpdaterCacheDirName('a/b-updater')).toBe(false);
    expect(isSafeUpdaterCacheDirName('a\\b-updater')).toBe(false);
    expect(isSafeUpdaterCacheDirName('/-updater')).toBe(false);
  });

  it('rejects the bare suffix, which carries no app identity', () => {
    expect(isSafeUpdaterCacheDirName('-updater')).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(isSafeUpdaterCacheDirName('')).toBe(false);
  });
});

describe('resolveUpdaterCacheDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-res-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when app-update.yml is absent, as in a dev build', () => {
    expect(resolveUpdaterCacheDir(dir)).toBeNull();
  });

  it('returns null when the recorded name is not safe to delete', () => {
    fs.writeFileSync(path.join(dir, 'app-update.yml'), 'updaterCacheDirName: ../../Documents\n');
    expect(resolveUpdaterCacheDir(dir)).toBeNull();
  });

  it('resolves inside the platform cache directory', () => {
    fs.writeFileSync(path.join(dir, 'app-update.yml'), "updaterCacheDirName: 'x-updater'\n");
    const resolved = resolveUpdaterCacheDir(dir);
    expect(resolved).not.toBeNull();
    expect(path.basename(resolved!)).toBe('x-updater');
  });
});

describe('purgeUpdaterCache', () => {
  let root: string;
  let resources: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-purge-'));
    resources = path.join(root, 'Resources');
    fs.mkdirSync(resources);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does nothing and reports zero when there is no app-update.yml', () => {
    expect(purgeUpdaterCache(resources)).toBe(0);
  });

  it('does nothing when the cache directory does not exist', () => {
    fs.writeFileSync(path.join(resources, 'app-update.yml'), "updaterCacheDirName: 'x-updater'\n");
    expect(purgeUpdaterCache(resources)).toBe(0);
  });

  it('deletes the cache and reports the bytes freed', () => {
    const cacheHome = path.join(root, 'cache');
    fs.mkdirSync(cacheHome);
    const cacheDir = path.join(cacheHome, 'x-updater');
    fs.mkdirSync(path.join(cacheDir, 'pending'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'update.zip'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(cacheDir, 'pending', 'app.zip'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(resources, 'app-update.yml'), "updaterCacheDirName: 'x-updater'\n");

    expect(purgeUpdaterCache(resources, cacheHome)).toBe(3072);
    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it('leaves a sibling directory in the same cache root untouched', () => {
    const cacheHome = path.join(root, 'cache');
    fs.mkdirSync(cacheHome);
    const ours = path.join(cacheHome, 'x-updater');
    const theirs = path.join(cacheHome, 'com.apple.Safari');
    fs.mkdirSync(ours);
    fs.mkdirSync(theirs);
    fs.writeFileSync(path.join(ours, 'update.zip'), Buffer.alloc(16));
    fs.writeFileSync(path.join(theirs, 'important'), Buffer.alloc(16));
    fs.writeFileSync(path.join(resources, 'app-update.yml'), "updaterCacheDirName: 'x-updater'\n");

    purgeUpdaterCache(resources, cacheHome);
    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(theirs)).toBe(true);
  });

  it('refuses to delete anything when the recorded name is hostile', () => {
    const cacheHome = path.join(root, 'cache');
    fs.mkdirSync(cacheHome);
    const victim = path.join(root, 'Documents');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'thesis.txt'), 'x');
    fs.writeFileSync(
      path.join(resources, 'app-update.yml'),
      "updaterCacheDirName: '../Documents'\n",
    );

    expect(purgeUpdaterCache(resources, cacheHome)).toBe(0);
    expect(fs.existsSync(path.join(victim, 'thesis.txt'))).toBe(true);
  });
});
