import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  utimesSync,
  statSync,
  mkdirSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { translationResultKey, RESULT_CACHE_LIMIT, RESULT_CACHE_BYTES, TranslationError, type StoredConnection } from '@backspace/translation';
import { TranslationResultCache } from './resultCache';

let directory: string;
let cache: TranslationResultCache;
// Test cipher only; production injection is Electron safeStorage, verified by IPC tests.
const encryption = {
  encrypt: (value: string) => Buffer.from(Buffer.from(value).toString('base64')),
  decrypt: (value: Buffer) => Buffer.from(value.toString(), 'base64').toString(),
};
const connection: StoredConnection = {
  id: 'one',
  name: 'AI',
  protocol: 'openai-chat',
  baseUrl: 'https://api.example/v1',
  model: 'model',
  apiKey: 'secret',
};
const input = { text: 'Hello', target: 'zh-CN' as const, engine: 'one', connection };
const key = translationResultKey(input);
const scope = 'https://chat.example\nalice';
const scopeDirectory = () => path.join(directory, createHash('sha256').update(scope).digest('hex'));
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'backspace-result-cache-'));
  cache = new TranslationResultCache(directory, encryption);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('encrypted local result cache', () => {
  it('persists across service restarts without plaintext source/translation/key metadata', () => {
    expect(cache.get(scope, key)).toBeNull();
    cache.set(scope, key, '你好');
    cache = new TranslationResultCache(directory, encryption);
    expect(cache.get(scope, key)).toBe('你好');
    const file = path.join(scopeDirectory(), readdirSync(scopeDirectory())[0]!);
    const bytes = readFileSync(file).toString();
    for (const secret of ['你好', 'Hello', 'secret', 'api.example']) expect(bytes).not.toContain(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(scopeDirectory()).mode & 0o777).toBe(0o700);
  });
  it('does not share cached results across accounts or home origins', () => {
    cache.set(scope, key, '你好');
    expect(cache.get('https://chat.example\nbob', key)).toBeNull();
    expect(cache.get('https://other.example\nalice', key)).toBeNull();
  });
  it('fails explicitly on corrupt cache rather than treating it as a paid cache miss', () => {
    cache.set(scope, key, '你好');
    writeFileSync(path.join(scopeDirectory(), key + '.bin'), 'broken');
    expect(() => cache.get(scope, key)).toThrowError(expect.objectContaining({ code: 'cache-storage' }));
  });
  it('fails closed when secure storage becomes unavailable', () => {
    const broken = new TranslationResultCache(directory, {
      ...encryption,
      encrypt: () => {
        throw new TranslationError('secure-storage');
      },
    });
    expect(() => broken.set(scope, key, '你好')).toThrowError(
      expect.objectContaining({ code: 'secure-storage' }),
    );
    expect(readdirSync(directory)).toEqual([]);
  });
  it('evicts least-recently-used results to stay within the count bound', () => {
    mkdirSync(scopeDirectory(), { recursive: true });
    for (let i = 0; i < RESULT_CACHE_LIMIT; i++) {
      const file = path.join(scopeDirectory(), i.toString(16).padStart(64, '0') + '.bin');
      writeFileSync(file, encryption.encrypt('"old"'));
      utimesSync(file, new Date(i * 1000), new Date(i * 1000));
    }
    const touched = '0'.repeat(64);
    expect(cache.get(scope, touched)).toBe('old');
    cache.set(scope, key, '你好');
    expect(readdirSync(scopeDirectory())).toHaveLength(RESULT_CACHE_LIMIT);
    expect(cache.get(scope, touched)).toBe('old');
    expect(cache.get(scope, '1'.padStart(64, '0'))).toBeNull();
  });
  it('also bounds disk bytes, independently of entry count', () => {
    mkdirSync(scopeDirectory(), { recursive: true });
    const old = path.join(scopeDirectory(), '0'.repeat(64) + '.bin');
    writeFileSync(old, Buffer.alloc(RESULT_CACHE_BYTES));
    utimesSync(old, new Date(0), new Date(0));
    cache.set(scope, key, '你好');
    expect(readdirSync(scopeDirectory())).toEqual([key + '.bin']);
  });
});

describe('translation semantic identity', () => {
  it('ignores connection ID, name and key rotation for the same endpoint/protocol/model', () => {
    expect(
      translationResultKey({
        ...input,
        engine: 'two',
        connection: {
          ...connection,
          id: 'two',
          name: 'renamed',
          apiKey: 'rotated',
        },
      }),
    ).toBe(key);
  });
  it('includes exact source, target, protocol, endpoint and model', () => {
    for (const change of [
      { text: 'Hello!' },
      { target: 'de' as const },
      { connection: { ...connection, protocol: 'openai-responses' as const } },
      { connection: { ...connection, baseUrl: 'https://other.example/v1' } },
      { connection: { ...connection, model: 'other' } },
    ]) {
      expect(translationResultKey({ ...input, ...change })).not.toBe(key);
    }
    expect(translationResultKey({ ...input, engine: 'google-free', connection: undefined })).not.toBe(
      translationResultKey({ ...input, engine: 'microsoft-free', connection: undefined }),
    );
  });
});
