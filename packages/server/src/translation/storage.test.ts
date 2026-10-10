import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESULT_CACHE_LIMIT, RESULT_CACHE_BYTES } from '@backspace/translation';
import { TranslationEncryption } from './encryption.js';
import { ServerTranslationStorage } from './storage.js';

let db: Database.Database;
let storage: ServerTranslationStorage;
const encryption = new TranslationEncryption('ab'.repeat(32));
const ALICE = 'server\nalice';
const BOB = 'server\nbob';
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY, is_deleted INTEGER DEFAULT 0)');
  db.exec(readFileSync(new URL('../../drizzle/0027_ai_translation.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO users(id) VALUES (?), (?)').run('alice', 'bob');
  storage = new ServerTranslationStorage(db, encryption);
});
afterEach(() => db.close());

describe('encrypted per-account storage', () => {
  it('persists only ciphertext and reloads it without mixing accounts', () => {
    storage.vault.write(ALICE, '{"apiKey":"test-secret"}');
    storage.cache.set(ALICE, 'body-hash', 'translated text');
    expect(storage.vault.read(BOB)).toBeNull();
    expect(storage.cache.get(BOB, 'body-hash')).toBeNull();
    const restarted = new ServerTranslationStorage(db, encryption);
    expect(restarted.vault.read(ALICE)).toBe('{"apiKey":"test-secret"}');
    expect(restarted.cache.get(ALICE, 'body-hash')).toBe('translated text');
    expect(db.serialize().includes('test-secret')).toBe(false);
    expect(db.serialize().includes('translated text')).toBe(false);
  });
  it('refuses swapped ciphertext, rather than treating corruption as a cache miss', () => {
    storage.vault.write(ALICE, 'private settings');
    storage.vault.write(BOB, 'other settings');
    db.exec("UPDATE ai_translation_settings SET encrypted = (SELECT encrypted FROM ai_translation_settings WHERE user_id = 'alice') WHERE user_id = 'bob'");
    expect(() => storage.vault.read(BOB)).toThrow('storage');
    storage.cache.set(ALICE, 'first', 'translated text');
    db.exec("UPDATE ai_translation_results SET result_key = 'second'");
    expect(() => storage.cache.get(ALICE, 'second')).toThrow('cache-storage');
  });
  it.each(['soft', 'hard'])('purges %s-deleted accounts and prevents delayed writes resurrecting secrets', mode => {
    storage.vault.write(ALICE, 'private');
    storage.cache.set(ALICE, 'body', 'translated');
    db.exec(mode === 'soft' ? "UPDATE users SET is_deleted = 1 WHERE id = 'alice'" : "DELETE FROM users WHERE id = 'alice'");
    expect(db.prepare('SELECT * FROM ai_translation_settings').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM ai_translation_results').all()).toHaveLength(0);
    expect(() => storage.vault.write(ALICE, 'late')).toThrow('untrusted-sender');
    expect(() => storage.cache.set(ALICE, 'body', 'late')).toThrow('untrusted-sender');
  });
  it('enforces per-account LRU count without deleting another account', () => {
    storage.cache.set(BOB, 'keep', 'other translation');
    for (let i = 0; i <= RESULT_CACHE_LIMIT; i++) storage.cache.set(ALICE, String(i), 'translated');
    expect(storage.cache.get(ALICE, '0')).toBeNull();
    expect(storage.cache.get(ALICE, String(RESULT_CACHE_LIMIT))).toBe('translated');
    expect(storage.cache.get(BOB, 'keep')).toBe('other translation');
  });
  it('enforces the encrypted byte budget', () => {
    db.prepare('INSERT INTO ai_translation_results VALUES (?, ?, ?, ?)').run('alice', 'oversized', Buffer.alloc(RESULT_CACHE_BYTES), 0);
    storage.cache.set(ALICE, 'new', 'translated');
    expect(storage.cache.get(ALICE, 'oversized')).toBeNull();
    expect(storage.cache.get(ALICE, 'new')).toBe('translated');
  });
  it('does not accept non-server scopes', () => {
    expect(() => storage.vault.read('https://example.org\nalice')).toThrow('untrusted-sender');
  });
});
