import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { TranslationEncryption } from './encryption.js';

export const TRANSLATION_KEY_FILE = 'ai-translation.key';
interface KeyOptions { db: Database.Database; dbPath: string; keyHex?: string }
function exists(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw new Error('Translation encryption key must be a regular file.');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function encryptedSamples(db: Database.Database): { encrypted: Buffer; context: string }[] {
  return db.prepare(
    "SELECT encrypted, 'settings:server' || char(10) || user_id AS context FROM ai_translation_settings LIMIT 1"
  ).all().concat(db.prepare(
    "SELECT encrypted, 'result:server' || char(10) || user_id || ':' || result_key AS context FROM ai_translation_results LIMIT 1"
  ).all()) as { encrypted: Buffer; context: string }[];
}
function createKeyFile(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, randomBytes(32).toString('hex') + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    // Publish a complete file without overwriting: concurrent starts must all read the same winning key.
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally { unlinkSync(temporary); }
}
/** Stable per-installation key on the data volume, never a timestamp/hardware-derived secret. */
export function loadTranslationEncryption({ db, dbPath, keyHex }: KeyOptions): TranslationEncryption {
  const samples = encryptedSamples(db);
  let key = keyHex;
  if (!key) {
    if (dbPath === ':memory:') throw new Error('In-memory databases require an explicit AI_TRANSLATION_ENCRYPTION_KEY.');
    const path = join(dirname(resolve(dbPath)), TRANSLATION_KEY_FILE);
    if (!exists(path)) {
      if (samples.length) throw new Error('Translation encryption key is missing for existing data. Restore ai-translation.key or the original AI_TRANSLATION_ENCRYPTION_KEY; a new key cannot decrypt it.');
      createKeyFile(path);
    }
    if (!exists(path)) throw new Error('Translation encryption key file was not created.');
    key = readFileSync(path, 'utf8').trim();
  }
  const encryption = new TranslationEncryption(key);
  try {
    samples.forEach(sample => encryption.decrypt(sample.encrypted, sample.context));
  } catch {
    throw new Error('Translation encryption key does not match stored data, or the data is damaged. Restore the original key and matching database backup.');
  }
  return encryption;
}
