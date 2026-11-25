import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { TranslationEncryption } from './encryption.js';

export const TRANSLATION_KEY_FILE = 'ai-translation.key';

interface KeyOptions {
  db: Database.Database;
  dbPath: string;
  keyHex?: string;
}

function fileExists(filePath: string): boolean {
  try {
    if (!lstatSync(filePath).isFile()) {
      throw new Error('Translation encryption key must be a regular file.');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function readInstanceId(db: Database.Database): string {
  const row = db.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as
    | { instance_id: string | null }
    | undefined;
  return row?.instance_id || 'default-instance';
}

function readEncryptedSamples(db: Database.Database): Array<{ encrypted: Buffer; context: string }> {
  const instanceId = readInstanceId(db);
  const providerRows = db.prepare(
    'SELECT encrypted_api_key AS encrypted FROM ai_translation_provider WHERE id = 1 LIMIT 1',
  ).all() as Array<{ encrypted: Buffer }>;

  const cacheRows = db.prepare(
    'SELECT instance_id, user_id, result_key, encrypted FROM ai_translation_cache LIMIT 1',
  ).all() as Array<{ instance_id: string; user_id: string; result_key: string; encrypted: Buffer }>;

  const samples: Array<{ encrypted: Buffer; context: string }> = [];
  for (const row of providerRows) {
    samples.push({ encrypted: row.encrypted, context: `provider:${instanceId}:1` });
  }
  for (const row of cacheRows) {
    samples.push({
      encrypted: row.encrypted,
      context: `cache:${row.instance_id}:${row.user_id}:${row.result_key}`,
    });
  }
  return samples;
}

function publishKeyFile(filePath: string): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, `${randomBytes(32).toString('hex')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Already cleaned up
    }
  }
}

/**
 * Loads `AI_TRANSLATION_ENCRYPTION_KEY` or provisions a mode-0600 `ai-translation.key`
 * file next to `DB_PATH`. Fails fast if encrypted rows exist and cannot be decrypted.
 */
export function loadTranslationEncryption({ db, dbPath, keyHex }: KeyOptions): TranslationEncryption {
  const samples = readEncryptedSamples(db);
  let resolvedHex = keyHex?.trim() || '';

  if (!resolvedHex) {
    if (dbPath === ':memory:') {
      if (samples.length > 0) {
        throw new Error('In-memory database contains encrypted translation rows without AI_TRANSLATION_ENCRYPTION_KEY.');
      }
      resolvedHex = randomBytes(32).toString('hex');
    } else {
      const keyPath = join(dirname(resolve(dbPath)), TRANSLATION_KEY_FILE);
      if (!fileExists(keyPath)) {
        if (samples.length > 0) {
          throw new Error(
            'Translation encryption key is missing for existing data. Restore ai-translation.key or AI_TRANSLATION_ENCRYPTION_KEY.',
          );
        }
        publishKeyFile(keyPath);
      }
      if (!fileExists(keyPath)) {
        throw new Error('Translation encryption key file was not created.');
      }
      resolvedHex = readFileSync(keyPath, 'utf8').trim();
    }
  }

  const encryption = new TranslationEncryption(resolvedHex);
  try {
    for (const sample of samples) {
      encryption.decrypt(sample.encrypted, sample.context);
    }
  } catch {
    throw new Error(
      'Translation encryption key does not match stored data, or the stored ciphertext is damaged.',
    );
  }
  return encryption;
}
