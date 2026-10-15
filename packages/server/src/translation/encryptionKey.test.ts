import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTranslationEncryption, TRANSLATION_KEY_FILE } from './encryptionKey.js';
let directory: string;
let db: Database.Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'translation-key-test-'));
  db = new Database(':memory:');
  db.exec('CREATE TABLE ai_translation_settings (user_id TEXT PRIMARY KEY, encrypted BLOB); CREATE TABLE ai_translation_results (user_id TEXT, result_key TEXT, encrypted BLOB);');
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
function options() { return { db, dbPath: join(directory, 'db.sqlite') }; }
function keyPath() { return join(directory, TRANSLATION_KEY_FILE); }
describe('installation encryption key', () => {
  it('creates one secure random key and reuses it after restart', () => {
    const first = loadTranslationEncryption(options());
    const saved = readFileSync(keyPath(), 'utf8').trim();
    expect(saved).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
    const encrypted = first.encrypt('private-config', 'settings:server\nalice');
    db.prepare('INSERT INTO ai_translation_settings VALUES (?, ?)').run('alice', encrypted);
    const second = loadTranslationEncryption(options());
    expect(second.decrypt(encrypted, 'settings:server\nalice')).toBe('private-config');
    expect(readFileSync(keyPath(), 'utf8').trim()).toBe(saved);
    expect(readdirSync(directory)).toEqual([TRANSLATION_KEY_FILE]);
  });
  it('retains explicit-key deployments without creating another key file', () => {
    const keyHex = 'ab'.repeat(32);
    const first = loadTranslationEncryption({ ...options(), keyHex });
    db.prepare('INSERT INTO ai_translation_settings VALUES (?, ?)').run('alice', first.encrypt('config', 'settings:server\nalice'));
    expect(() => loadTranslationEncryption({ ...options(), keyHex })).not.toThrow();
    expect(readdirSync(directory)).toEqual([]);
    expect(() => loadTranslationEncryption(options())).toThrow('missing for existing data');
    expect(readdirSync(directory)).toEqual([]);
  });
  it('fails on lost or changed keys rather than silently resetting data', () => {
    const first = loadTranslationEncryption(options());
    const encrypted = first.encrypt('config', 'settings:server\nalice');
    db.prepare('INSERT INTO ai_translation_settings VALUES (?, ?)').run('alice', encrypted);
    expect(() => loadTranslationEncryption({ ...options(), keyHex: 'cd'.repeat(32) })).toThrow('does not match');
    unlinkSync(keyPath());
    expect(() => loadTranslationEncryption(options())).toThrow('missing for existing data');
    expect(db.prepare('SELECT encrypted FROM ai_translation_settings').get()).toEqual({ encrypted });
  });
  it('also checks caches when no settings remain', () => {
    const first = loadTranslationEncryption({ ...options(), keyHex: 'ab'.repeat(32) });
    db.prepare('INSERT INTO ai_translation_results VALUES (?, ?, ?)').run('alice', 'cache', first.encrypt('translation', 'result:server\nalice:cache'));
    expect(() => loadTranslationEncryption(options())).toThrow('missing for existing data');
    expect(() => loadTranslationEncryption({ ...options(), keyHex: 'cd'.repeat(32) })).toThrow('does not match');
  });
  it('rejects malformed files and explicit overrides without regeneration', () => {
    writeFileSync(keyPath(), 'invalid');
    expect(() => loadTranslationEncryption(options())).toThrow('64 hexadecimal');
    expect(readFileSync(keyPath(), 'utf8')).toBe('invalid');
    expect(() => loadTranslationEncryption({ ...options(), keyHex: 'wrong' })).toThrow('64 hexadecimal');
  });
  it('gives the explicit key precedence and creates no ephemeral key for memory databases', () => {
    writeFileSync(keyPath(), 'ab'.repeat(32));
    const override = loadTranslationEncryption({ ...options(), keyHex: 'cd'.repeat(32) });
    const expected = loadTranslationEncryption({ db, dbPath: ':memory:', keyHex: 'cd'.repeat(32) });
    expect(expected.decrypt(override.encrypt('text', 'context'), 'context')).toBe('text');
    expect(() => loadTranslationEncryption({ db, dbPath: ':memory:' })).toThrow('explicit');
  });
});

it('refuses a symlink key instead of reading or replacing its target', () => {
  const target = join(directory, 'original.key');
  const saved = 'ab'.repeat(32);
  writeFileSync(target, saved);
  symlinkSync(target, keyPath());
  expect(() => loadTranslationEncryption(options())).toThrow('regular file');
  expect(readFileSync(target, 'utf8')).toBe(saved);
});
