import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as dbSchema from '../db/schema.js';
import { ALL_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';
import { translationRoutes } from './translation.js';

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof dbSchema>>;
let app: FastifyInstance;
// Generated per run rather than written as a literal: the upstream gitleaks
// scan (generic-api-key) blocks any key-shaped constant in history, and no test
// depends on a specific key value, only on encrypt/decrypt using the same one.
const TEST_KEY = randomBytes(32).toString('hex');

vi.mock('../db/index.js', async () => {
  const actualSchema = await vi.importActual('../db/schema.js');
  return {
    getDb: () => db,
    getRawDb: () => sqlite,
    schema: actualSchema,
  };
});

vi.mock('../config.js', () => ({
  config: {
    dbPath: ':memory:',
  },
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (
    request: { userId?: string; username?: string; headers: Record<string, string | undefined> },
    reply: { code: (c: number) => { send: (b?: unknown) => unknown } },
  ) => {
    const auth = request.headers.authorization;
    if (!auth) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
    const id = auth.replace(/^Bearer\s+/i, '');
    request.userId = id;
    request.username = id;
  },
  requireAdmin: async (
    request: { userId?: string },
    reply: { code: (c: number) => { send: (b?: unknown) => unknown } },
  ) => {
    if (request.userId !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden', statusCode: 403 });
    }
  },
}));

let mockProviderFetch = vi.fn();

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema: dbSchema });
  migrate(db, { migrationsFolder: path.resolve('drizzle') });

  sqlite.prepare(
    `INSERT INTO instance_settings
      (id, instance_id, max_bitrate_kbps, min_bitrate_kbps, bitrate_step_kbps, allowed_resolutions, allowed_framerates, max_resolution, max_framerate, updated_at)
     VALUES (1, 'inst-alpha', 20000, 500, 500, '720,1080', '30,60', 1080, 60, 1)`,
  ).run();

  for (const id of ['admin', 'alice', 'bob', 'outsider']) {
    sqlite.prepare(
      'INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, 1)',
    ).run(id, id, 'hash', id === 'admin' ? 1 : 0);
  }

  db.insert(dbSchema.spaces).values({ id: 'sp1', name: 'Alpha Space', ownerId: 'admin', createdAt: 1 }).run();
  db.insert(dbSchema.roles).values({ id: 'sp1', spaceId: 'sp1', name: '@everyone', permissions: permissionsToString(ALL_PERMISSIONS), position: 0, createdAt: 1 }).run();
  db.insert(dbSchema.spaceMembers).values({ spaceId: 'sp1', userId: 'alice', joinedAt: 1 }).run();
  db.insert(dbSchema.spaceMembers).values({ spaceId: 'sp1', userId: 'bob', joinedAt: 1 }).run();
  db.insert(dbSchema.channels).values({ id: 'ch1', spaceId: 'sp1', name: 'general', type: 'text', position: 0, createdAt: 1 }).run();
  db.insert(dbSchema.messages).values({ id: 'msg1', channelId: 'ch1', userId: 'alice', content: '你好 `npm test` https://backspace.example', type: 'user', createdAt: 1 }).run();

  db.insert(dbSchema.dmChannels).values({ id: 'dm1', createdAt: 1 }).run();
  db.insert(dbSchema.dmMembers).values({ dmChannelId: 'dm1', userId: 'alice' }).run();
  db.insert(dbSchema.dmMessages).values({ id: 'dmmsg1', dmChannelId: 'dm1', userId: 'alice', content: '这是一条私信', createdAt: 1 }).run();

  mockProviderFetch = vi.fn();
  app = Fastify();
  await app.register(translationRoutes, {
    encryptionKeyHex: TEST_KEY,
    providerFetch: mockProviderFetch as unknown as typeof fetch,
  });
});

afterEach(async () => {
  await app?.close();
  sqlite?.close();
});

describe('single-provider instance message translation routes', () => {
  it('stays off by default and rejects translation requests when disabled', async () => {
    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/translation/status',
      headers: { authorization: 'Bearer alice' },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toEqual({
      enabled: false,
      provider: null,
      preferences: {
        consented: false,
        consentedAt: null,
        targetLanguage: 'en',
        showOriginal: true,
      },
    });

    const translateRes = await app.inject({
      method: 'POST',
      url: '/api/translation/translate',
      headers: { authorization: 'Bearer alice' },
      payload: { channelId: 'ch1', messageId: 'msg1', providerFingerprint: 'any' },
    });
    expect(translateRes.statusCode).toBe(404);
    expect(translateRes.json().code).toBe('translation_disabled');
  });

  it('encrypts provider key server-side, never exposes it, and blocks non-HTTPS/private endpoints', async () => {
    const unsafeRes = await app.inject({
      method: 'PUT',
      url: '/api/admin/translation',
      headers: { authorization: 'Bearer admin' },
      payload: {
        enabled: true,
        providerLabel: 'Local',
        protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-secret-value',
      },
    });
    expect(unsafeRes.statusCode).toBe(400);
    expect(unsafeRes.json().code).toBe('translation_unsafe_endpoint');

    const saveRes = await app.inject({
      method: 'PUT',
      url: '/api/admin/translation',
      headers: { authorization: 'Bearer admin' },
      payload: {
        enabled: true,
        providerLabel: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1/',
        model: 'gpt-4o-mini',
        apiKey: 'sk-super-secret-admin-key',
      },
    });
    expect(saveRes.statusCode).toBe(200);
    const saved = saveRes.json();
    expect(saved.hasApiKey).toBe(true);
    expect(saved.baseUrl).toBe('https://api.openai.com/v1');
    expect(JSON.stringify(saved)).not.toContain('sk-super-secret-admin-key');

    // Stored key in SQLite is ciphertext, not plaintext.
    const rawRow = sqlite.prepare('SELECT encrypted_api_key FROM ai_translation_provider WHERE id = 1').get() as {
      encrypted_api_key: Buffer;
    };
    expect(rawRow.encrypted_api_key.toString('utf8')).not.toContain('sk-super-secret-admin-key');

    // Changing baseUrl without providing a new key is rejected so stored key never leaks to a new host.
    const changeHostRes = await app.inject({
      method: 'PUT',
      url: '/api/admin/translation',
      headers: { authorization: 'Bearer admin' },
      payload: {
        enabled: true,
        providerLabel: 'Other Host',
        protocol: 'openai-chat',
        baseUrl: 'https://api.other-llm.example/v1',
        model: 'gpt-4o-mini',
      },
    });
    expect(changeHostRes.statusCode).toBe(400);
    expect(changeHostRes.json().code).toBe('translation_provider_invalid');
  });

  it('enforces explicit user consent before first transfer, sends minimal payload, and isolates account/instance caches', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/admin/translation',
      headers: { authorization: 'Bearer admin' },
      payload: {
        enabled: true,
        providerLabel: 'OpenAI',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1-mini',
        apiKey: 'sk-instance-key',
      },
    });

    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/translation/status',
      headers: { authorization: 'Bearer alice' },
    });
    const status = statusRes.json();
    expect(status.enabled).toBe(true);
    expect(status.provider).toMatchObject({
      label: 'OpenAI',
      host: 'api.openai.com',
    });
    expect(status.preferences.consented).toBe(false);
    const fingerprint = status.provider.fingerprint as string;

    // 1. Before consent, translation is refused and provider is NOT contacted.
    const noConsentRes = await app.inject({
      method: 'POST',
      url: '/api/translation/translate',
      headers: { authorization: 'Bearer alice' },
      payload: {
        channelId: 'ch1',
        messageId: 'msg1',
        targetLanguage: 'en',
        providerFingerprint: fingerprint,
      },
    });
    expect(noConsentRes.statusCode).toBe(403);
    expect(noConsentRes.json().code).toBe('translation_consent_required');
    expect(mockProviderFetch).not.toHaveBeenCalled();

    // 2. Alice grants consent to this instance's provider.
    const consentRes = await app.inject({
      method: 'PUT',
      url: '/api/translation/preferences',
      headers: { authorization: 'Bearer alice' },
      payload: {
        consent: true,
        providerFingerprint: fingerprint,
        targetLanguage: 'en',
      },
    });
    expect(consentRes.statusCode).toBe(200);
    expect(consentRes.json().preferences.consented).toBe(true);

    // 3. Outsider (not a space member) cannot translate Alice's channel message even after consenting.
    await app.inject({
      method: 'PUT',
      url: '/api/translation/preferences',
      headers: { authorization: 'Bearer outsider' },
      payload: { consent: true, providerFingerprint: fingerprint, targetLanguage: 'en' },
    });
    const forbiddenChannelRes = await app.inject({
      method: 'POST',
      url: '/api/translation/translate',
      headers: { authorization: 'Bearer outsider' },
      payload: { channelId: 'ch1', messageId: 'msg1', providerFingerprint: fingerprint },
    });
    expect(forbiddenChannelRes.statusCode).toBe(403);

    // Bob (not a member of dm1) cannot translate Alice's DM message.
    await app.inject({
      method: 'PUT',
      url: '/api/translation/preferences',
      headers: { authorization: 'Bearer bob' },
      payload: { consent: true, providerFingerprint: fingerprint, targetLanguage: 'en' },
    });
    const forbiddenDmRes = await app.inject({
      method: 'POST',
      url: '/api/translation/translate',
      headers: { authorization: 'Bearer bob' },
      payload: { dmChannelId: 'dm1', messageId: 'dmmsg1', providerFingerprint: fingerprint },
    });
    expect(forbiddenDmRes.statusCode).toBe(403);

    // 4. Alice translates msg1: inspect exact payload sent to provider.
    let capturedBody = '';
    mockProviderFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      const outer = JSON.parse(capturedBody) as { input: string; store: boolean };
      expect(outer.store).toBe(false);
      const inner = JSON.parse(outer.input) as { targetLanguage: string; untrustedText: string };
      expect(Object.keys(inner).sort()).toEqual(['targetLanguage', 'untrustedText']);
      expect(inner.targetLanguage).toBe('en');
      // Code and URL are masked; author/channel/messageId metadata are NOT present!
      expect(inner.untrustedText).not.toContain('npm test');
      expect(inner.untrustedText).not.toContain('backspace.example');
      expect(capturedBody).not.toContain('alice');
      expect(capturedBody).not.toContain('ch1');
      expect(capturedBody).not.toContain('msg1');

      const placeholders = inner.untrustedText.match(/__BS_[a-f0-9]{16}_\d+__/g) ?? [];
      expect(placeholders).toHaveLength(2);
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    translation: `Hello ${placeholders[0]} ${placeholders[1]}`,
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const firstTranslate = await app.inject({
      method: 'POST',
      url: '/api/translation/translate',
      headers: { authorization: 'Bearer alice' },
      payload: { channelId: 'ch1', messageId: 'msg1', providerFingerprint: fingerprint },
    });
    expect(firstTranslate.statusCode).toBe(200);
    expect(firstTranslate.json()).toEqual({
      kind: 'translated',
      text: 'Hello `npm test` https://backspace.example',
      targetLanguage: 'en',
      cached: false,
    });
    expect(mockProviderFetch).toHaveBeenCalledTimes(1);

    // Repeat request by Alice hits Alice's encrypted cache without calling provider.
    const cachedTranslate = await app.inject({
      method: 'POST',
      url: '/api/translation/translate',
      headers: { authorization: 'Bearer alice' },
      payload: { channelId: 'ch1', messageId: 'msg1', providerFingerprint: fingerprint },
    });
    expect(cachedTranslate.statusCode).toBe(200);
    expect(cachedTranslate.json().cached).toBe(true);
    expect(mockProviderFetch).toHaveBeenCalledTimes(1);

    // 5. Account isolation: Bob's translation does NOT hit Alice's cache.
    mockProviderFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const outer = JSON.parse(String(init.body)) as { input: string };
      const inner = JSON.parse(outer.input) as { untrustedText: string };
      const placeholders = inner.untrustedText.match(/__BS_[a-f0-9]{16}_\d+__/g) ?? [];
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    translation: `Hi ${placeholders[0]} ${placeholders[1]}`,
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    });
    const bobTranslate = await app.inject({
      method: 'POST',
      url: '/api/translation/translate',
      headers: { authorization: 'Bearer bob' },
      payload: { channelId: 'ch1', messageId: 'msg1', providerFingerprint: fingerprint },
    });
    expect(bobTranslate.statusCode).toBe(200);
    expect(bobTranslate.json().cached).toBe(false);
    expect(mockProviderFetch).toHaveBeenCalledTimes(2);

    // 6. Soft-deleting Alice purges her consent and cached translations via SQLite trigger.
    sqlite.prepare('UPDATE users SET is_deleted = 1 WHERE id = ?').run('alice');
    const alicePrefsCount = (
      sqlite.prepare('SELECT COUNT(*) AS n FROM ai_translation_preferences WHERE user_id = ?').get('alice') as { n: number }
    ).n;
    const aliceCacheCount = (
      sqlite.prepare('SELECT COUNT(*) AS n FROM ai_translation_cache WHERE user_id = ?').get('alice') as { n: number }
    ).n;
    expect(alicePrefsCount).toBe(0);
    expect(aliceCacheCount).toBe(0);

    // 7. Switching the provider host invalidates Bob's prior consent until Bob consents to the new host.
    await app.inject({
      method: 'PUT',
      url: '/api/admin/translation',
      headers: { authorization: 'Bearer admin' },
      payload: {
        enabled: true,
        providerLabel: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-haiku-latest',
        apiKey: 'sk-ant-key',
      },
    });
    const bobStatusAfterSwitch = await app.inject({
      method: 'GET',
      url: '/api/translation/status',
      headers: { authorization: 'Bearer bob' },
    });
    expect(bobStatusAfterSwitch.json().preferences.consented).toBe(false);
  });
});
