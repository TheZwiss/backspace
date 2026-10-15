import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationCommand, TranslationSettings } from '@backspace/shared/translation';
import * as schema from '../db/schema.js';
import { signJwt } from '../utils/auth.js';
import { serverProviderFetch } from '../translation/providerFetch.js';
import { translationRoutes } from './translation.js';

let db: Database.Database;
let app: FastifyInstance;
let logs: string;
vi.mock('../db/index.js', () => ({ getDb: () => drizzle(db, { schema }), getRawDb: () => db, schema }));
vi.mock('../translation/providerFetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../translation/providerFetch.js')>(), serverProviderFetch: vi.fn(),
}));
const apiKey = 'test-credential-not-for-logs';
const source = 'Could you please check this message when you have time?';
const connection = { name: 'Private', protocol: 'openai-chat' as const, baseUrl: 'https://provider.example/v1', model: 'translator', apiKey };
function request(command: TranslationCommand, userId = 'alice') {
  return app.inject({ method: 'POST', url: '/api/translation/command', payload: command,
    headers: { authorization: 'Bearer ' + signJwt({ userId, username: userId }) } });
}
async function configured(): Promise<TranslationSettings> {
  const saved = (await request({ action: 'saveConnection', accountId: 'alice', connection })).json().settings as TranslationSettings;
  const result = await request({ action: 'savePreferences', accountId: 'alice', preferences: {
    ...saved.preferences, consent: true, automatic: true, targetLanguage: 'zh-CN',
  } });
  return result.json().settings;
}
function providerResponse() {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translation: '请在有空的时候检查一下这条消息。' }) } }] });
}
beforeEach(async () => {
  vi.stubEnv('AI_TRANSLATION_ENCRYPTION_KEY', 'ab'.repeat(32));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrations = new URL('../../drizzle/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  for (const id of ['alice', 'bob', 'remote']) {
    drizzle(db, { schema }).insert(schema.users).values({ id, username: id, passwordHash: 'test', createdAt: Date.now(), homeInstance: id === 'remote' ? 'https://remote.example' : null }).run();
  }
  logs = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { logs += String(chunk); callback(); } });
  app = Fastify({ logger: { stream } });
  await app.register(translationRoutes);
  vi.mocked(serverProviderFetch).mockReset().mockImplementation(async () => providerResponse());
});
afterEach(async () => { await app.close(); db.close(); vi.unstubAllEnvs(); });

describe('authenticated Web translation API', () => {
  it('requires a valid login, refuses remote identities and account spoofing', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/translation/command', payload: { action: 'load', accountId: 'alice' } })).statusCode).toBe(401);
    expect((await request({ action: 'load', accountId: 'remote' }, 'remote')).statusCode).toBe(403);
    expect((await request({ action: 'load', accountId: 'bob' })).json()).toMatchObject({ ok: false, code: 'untrusted-sender' });
    expect(serverProviderFetch).not.toHaveBeenCalled();
  });
  it('encrypts credentials, never returns them, and isolates settings by login', async () => {
    const saved = await request({ action: 'saveConnection', accountId: 'alice', connection });
    expect(saved.json().settings.connections[0].hasKey).toBe(true);
    expect(saved.body).not.toContain(apiKey);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect((await request({ action: 'load', accountId: 'bob' }, 'bob')).json().settings.connections).toEqual([]);
    expect(db.serialize().includes(apiKey)).toBe(false);
    expect(logs).not.toContain(apiKey);
  });
  it('reuses translation results, refreshes edited text, and still skips the preferred language', async () => {
    const settings = await configured();
    const command: TranslationCommand = { action: 'translate', accountId: 'alice', text: source, revision: settings.revision, automatic: false };
    expect((await request(command)).json()).toMatchObject({ ok: true, result: { kind: 'translated' } });
    expect((await request(command)).json().ok).toBe(true);
    expect(serverProviderFetch).toHaveBeenCalledTimes(1);
    expect((await request({ ...command, text: source + ' I have updated the details.' })).json().ok).toBe(true);
    expect(serverProviderFetch).toHaveBeenCalledTimes(2);
    expect((await request({ ...command, text: '你好，请在有空的时候检查一下这条消息。' })).json()).toMatchObject({ ok: true, result: { kind: 'skipped', reason: 'same-language' } });
    expect(logs).not.toContain(source);
    expect(logs).not.toContain(apiKey);
  });
  it('coalesces identical in-flight requests without a second provider call', async () => {
    const settings = await configured();
    let finish!: (response: Response) => void;
    vi.mocked(serverProviderFetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const command: TranslationCommand = { action: 'translate', accountId: 'alice', text: source, revision: settings.revision, automatic: true };
    const first = request(command).then(response => response.json());
    const second = request(command).then(response => response.json());
    await vi.waitFor(() => expect(serverProviderFetch).toHaveBeenCalledTimes(1));
    finish(providerResponse());
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(serverProviderFetch).toHaveBeenCalledTimes(1);
  });
  it('blocks requests before consent and unsafe saved endpoints', async () => {
    expect((await request({ action: 'translate', accountId: 'alice', text: source, revision: 0, automatic: false })).json()).toMatchObject({ ok: false, code: 'consent-required' });
    expect((await request({ action: 'saveConnection', accountId: 'alice', connection: { ...connection, baseUrl: 'https://127.0.0.1' } })).json()).toMatchObject({ ok: false, code: 'unsafe-endpoint' });
    expect(serverProviderFetch).not.toHaveBeenCalled();
  });
  it('discovers models and tests unsaved credentials using the authenticated server transport', async () => {
    vi.mocked(serverProviderFetch).mockResolvedValueOnce(Response.json({ data: [{ id: 'translator' }] }));
    const listed = await request({ action: 'listModels', accountId: 'alice', connection: { ...connection, model: undefined } });
    expect(listed.json()).toEqual({ ok: true, models: ['translator'] });
    expect((await request({ action: 'testConnection', accountId: 'alice', connection })).json()).toMatchObject({ ok: true, test: { text: expect.any(String) } });
    expect(db.prepare('SELECT * FROM ai_translation_settings').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM ai_translation_results').all()).toHaveLength(0);
    expect(logs).not.toContain(apiKey);
  });
  it.each(['listModels', 'testConnection'] as const)('enforces endpoint restrictions for %s', async action => {
    const result = await request({ action, accountId: 'alice', connection: { ...connection, baseUrl: 'https://127.0.0.1' } });
    expect(result.json()).toMatchObject({ ok: false, code: 'unsafe-endpoint' });
    expect(serverProviderFetch).not.toHaveBeenCalled();
  });
  it('returns a safe provider failure without logging or retrying the echoed key/body', async () => {
    const settings = await configured();
    vi.mocked(serverProviderFetch).mockResolvedValue(new Response(apiKey + source, { status: 401 }));
    const result = await request({ action: 'translate', accountId: 'alice', text: source, revision: settings.revision, automatic: false });
    expect(result.json()).toEqual({ ok: false, code: 'http', status: 401 });
    expect(serverProviderFetch).toHaveBeenCalledTimes(1);
    expect(logs + result.body).not.toContain(apiKey);
    expect(logs + result.body).not.toContain(source);
  });
  it('does not resurrect credentials or cache after deletion during a request', async () => {
    const settings = await configured();
    vi.mocked(serverProviderFetch).mockImplementation(async () => {
      db.exec("UPDATE users SET is_deleted = 1 WHERE id = 'alice'");
      return providerResponse();
    });
    expect((await request({ action: 'translate', accountId: 'alice', text: source, revision: settings.revision, automatic: false })).json()).toMatchObject({ ok: false, code: 'untrusted-sender' });
    expect(db.prepare('SELECT * FROM ai_translation_results').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM ai_translation_settings').all()).toHaveLength(0);
  });
  it('works without a manually configured key for a fresh persistent installation', async () => {
    await app.close();
    vi.stubEnv('AI_TRANSLATION_ENCRYPTION_KEY', '');
    const directory = mkdtempSync(join(tmpdir(), 'translation-route-key-'));
    const previousPath = config.dbPath;
    Object.defineProperty(config, 'dbPath', { value: join(directory, 'backspace.db'), configurable: true });
    try {
      app = Fastify();
      await app.register(translationRoutes);
      const response = await request({ action: 'load', accountId: 'alice' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, settings: { connections: [] } });
      expect(readFileSync(join(directory, 'ai-translation.key'), 'utf8').trim()).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      Object.defineProperty(config, 'dbPath', { value: previousPath, configurable: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('fails registration for a malformed deployment key', async () => {
    await app.close();
    vi.stubEnv('AI_TRANSLATION_ENCRYPTION_KEY', 'bad-test-key');
    app = Fastify();
    await expect(app.register(translationRoutes)).rejects.toThrow('64 hexadecimal');
  });
});
