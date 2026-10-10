import type Database from 'better-sqlite3';
import { TranslationError, MAX_RESULT_LENGTH, RESULT_CACHE_BYTES, RESULT_CACHE_LIMIT, type VaultStorage, type ResultCache } from '@backspace/translation';
import type { TranslationEncryption } from './encryption.js';

export const SERVER_TRANSLATION_ORIGIN = 'server';
interface CipherRow { encrypted: Buffer }

/** Scope is built by TranslationService from the authenticated account, never the HTTP body. */
function owner(scope: string): string {
  if (!scope.startsWith(SERVER_TRANSLATION_ORIGIN + '\n')) throw new TranslationError('untrusted-sender');
  return scope.slice(SERVER_TRANSLATION_ORIGIN.length + 1);
}

export class ServerTranslationStorage {
  constructor(private readonly db: Database.Database, private readonly encryption: TranslationEncryption) {}
  private requireAccount(userId: string): void {
    if (!this.db.prepare('SELECT 1 FROM users WHERE id = ? AND COALESCE(is_deleted, 0) = 0').get(userId)) {
      throw new TranslationError('untrusted-sender');
    }
  }
  readonly vault: VaultStorage = {
    read: (scope) => {
      const userId = owner(scope);
      this.requireAccount(userId);
      try {
        const row = this.db.prepare('SELECT encrypted FROM ai_translation_settings WHERE user_id = ?').get(userId) as CipherRow | undefined;
        return row ? this.encryption.decrypt(row.encrypted, 'settings:' + scope) : null;
      } catch { throw new TranslationError('storage'); }
    },
    write: (scope, plaintext) => {
      const userId = owner(scope);
      this.requireAccount(userId);
      try {
        const encrypted = this.encryption.encrypt(plaintext, 'settings:' + scope);
        this.db.prepare('INSERT INTO ai_translation_settings (user_id, encrypted) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted = excluded.encrypted').run(userId, encrypted);
      } catch { throw new TranslationError('storage'); }
    },
  };
  readonly cache: ResultCache = {
    get: (scope, key) => {
      const userId = owner(scope);
      this.requireAccount(userId);
      try {
        const row = this.db.prepare('SELECT encrypted FROM ai_translation_results WHERE user_id = ? AND result_key = ?').get(userId, key) as CipherRow | undefined;
        if (!row) return null;
        const text = this.encryption.decrypt(row.encrypted, 'result:' + scope + ':' + key);
        if (!text.trim() || text.length > MAX_RESULT_LENGTH) throw new Error('Invalid cached translation');
        this.db.prepare('UPDATE ai_translation_results SET used_at = ? WHERE user_id = ? AND result_key = ?').run(Date.now(), userId, key);
        return text;
      } catch { throw new TranslationError('cache-storage'); }
    },
    set: (scope, key, text) => {
      const userId = owner(scope);
      this.requireAccount(userId);
      try {
        const encrypted = this.encryption.encrypt(text, 'result:' + scope + ':' + key);
        this.db.transaction(() => {
          this.db.prepare('INSERT INTO ai_translation_results (user_id, result_key, encrypted, used_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, result_key) DO UPDATE SET encrypted = excluded.encrypted, used_at = excluded.used_at').run(userId, key, encrypted, Date.now());
          this.prune(userId);
        })();
      } catch { throw new TranslationError('cache-storage'); }
    },
  };
  private prune(userId: string): void {
    const rows = this.db.prepare('SELECT result_key, length(encrypted) AS bytes FROM ai_translation_results WHERE user_id = ? ORDER BY used_at DESC, rowid DESC').all(userId) as { result_key: string; bytes: number }[];
    let bytes = 0;
    rows.forEach((row, index) => {
      bytes += row.bytes;
      if (index >= RESULT_CACHE_LIMIT || bytes > RESULT_CACHE_BYTES) {
        this.db.prepare('DELETE FROM ai_translation_results WHERE user_id = ? AND result_key = ?').run(userId, row.result_key);
      }
    });
  }
}
