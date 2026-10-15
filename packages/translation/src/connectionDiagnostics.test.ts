import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationService, TranslationVault, listModels, testConnection } from './index';
import type { TranslationProtocol } from '../../shared/src/translation';

const connection = { id: 'one', name: 'Private', protocol: 'openai-chat' as TranslationProtocol,
  baseUrl: 'https://provider.example/v1', model: 'chat-model', apiKey: 'private-key-not-in-results' };
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => fetcher.mockReset());
const response = (text = 'Hey, could you take a look when you have a moment?') =>
  Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translation: text }) } }] });

describe('protocol model discovery', () => {
  it.each(['openai-chat', 'openai-responses', 'anthropic'] as const)('lists %s models with authentication', async protocol => {
    fetcher.mockResolvedValue(Response.json({ data: [{ id: 'chat-b' }, { id: 'chat-a' }, { id: 'chat-b' }], has_more: false }));
    expect(await listModels({ connection: { ...connection, protocol }, fetcher })).toEqual(['chat-a', 'chat-b']);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/v1/models');
    const headers = new Headers(init?.headers);
    expect(headers.get(protocol === 'anthropic' ? 'x-api-key' : 'Authorization')).toContain(connection.apiKey);
    expect(init?.body).toBeUndefined();
    if (protocol === 'anthropic') expect(headers.get('anthropic-version')).toBe('2023-06-01');
  });
  it('paginates Gemini and lists only generateContent-capable models', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ models: [
      { name: 'models/chat-a', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
    ], nextPageToken: 'page2' })).mockResolvedValueOnce(Response.json({ models: [
      { name: 'models/chat-b', supportedGenerationMethods: ['generateContent'] },
    ] }));
    expect(await listModels({ connection: { ...connection, protocol: 'gemini' }, fetcher })).toEqual(['chat-a', 'chat-b']);
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('pageToken')).toBe('page2');
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('x-goog-api-key')).toBe(connection.apiKey);
    expect(String(fetcher.mock.calls[0]![0])).not.toContain(connection.apiKey);
  });
  it('paginates Anthropic without leaking keys in query strings', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'b' }], has_more: false }));
    expect(await listModels({ connection: { ...connection, protocol: 'anthropic' }, fetcher })).toEqual(['a', 'b']);
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('after_id')).toBe('a');
  });
  it('rejects repeated cursors instead of returning a partial list', async () => {
    fetcher.mockImplementation(async () => Response.json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }));
    await expect(listModels({ connection: { ...connection, protocol: 'anthropic' }, fetcher })).rejects.toMatchObject({ code: 'invalid-response' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('fails a missing model endpoint without inventing models or falling back', async () => {
    fetcher.mockResolvedValue(new Response(connection.apiKey, { status: 404 }));
    await expect(listModels({ connection, fetcher })).rejects.toMatchObject({ code: 'http', status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses oversized or credential-echoing model lists', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ data: Array.from({ length: 1001 }, (_, id) => ({ id: String(id) })) }));
    await expect(listModels({ connection, fetcher })).rejects.toMatchObject({ code: 'invalid-response' });
    fetcher.mockResolvedValueOnce(Response.json({ data: [{ id: connection.apiKey }] }));
    await expect(listModels({ connection, fetcher })).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it('rejects escaped credential echoes after decoding provider JSON', async () => {
    const escaped = [...connection.apiKey].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    fetcher.mockResolvedValue(new Response('{"data":[{"id":"' + escaped + '"}]}'));
    await expect(listModels({ connection, fetcher })).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it.each([null, {}, { data: [null] }, { data: [{ id: '' }] }, { data: [{ id: 12 }] }])('classifies malformed provider data as an invalid response', async value => {
    fetcher.mockResolvedValue(Response.json(value));
    await expect(listModels({ connection, fetcher })).rejects.toMatchObject({ code: 'invalid-response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns an empty listing honestly', async () => {
    fetcher.mockResolvedValue(Response.json({ data: [] }));
    expect(await listModels({ connection, fetcher })).toEqual([]);
  });
});

describe('unsaved connection diagnostics', () => {
  function setup() {
    const data = new Map<string, string>();
    const vault = new TranslationVault({ read: scope => data.get(scope) ?? null, write: (scope, value) => { data.set(scope, value); } });
    const cache = { get: vi.fn(), set: vi.fn() };
    const service = new TranslationService(vault, fetcher, cache);
    return { vault, service, cache };
  }
  it('uses the current draft/model without saving, consent changes or cached success', async () => {
    const { service, vault, cache } = setup();
    fetcher.mockImplementation(async () => response());
    const draft = { ...connection, id: undefined };
    for (let i = 0; i < 2; i += 1) {
      const result = await service.command('server', { action: 'testConnection', accountId: 'alice', connection: draft });
      expect(result).toMatchObject({ ok: true, test: { text: expect.any(String), latencyMs: expect.any(Number) } });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(vault.snapshot('server\nalice')).toMatchObject({ revision: 0, connections: [], preferences: { consent: false } });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).model).toBe('chat-model');
  });
  it('reuses a saved key only for its account and unchanged recipient', async () => {
    const { service, vault } = setup();
    const saved = vault.saveConnection('server\nalice', { ...connection, id: undefined });
    const draft = { ...connection, id: saved.connections[0]!.id, apiKey: undefined, model: undefined };
    fetcher.mockImplementation(async () => Response.json({ data: [{ id: 'a' }] }));
    expect(await service.command('server', { action: 'listModels', accountId: 'alice', connection: draft })).toEqual({ ok: true, models: ['a'] });
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Authorization')).toBe('Bearer ' + connection.apiKey);
    for (const override of [{ baseUrl: 'https://other.example' }, { protocol: 'gemini' }]) {
      expect(await service.command('server', { action: 'listModels', accountId: 'alice', connection: { ...draft, ...override } }))
        .toEqual({ ok: false, code: 'invalid-input' });
    }
    expect(await service.command('server', { action: 'listModels', accountId: 'bob', connection: draft }))
      .toEqual({ ok: false, code: 'missing-connection' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await service.command('server', { action: 'listModels', accountId: 'alice', connection: { ...draft, baseUrl: 'https://other.example', apiKey: '' } }))
      .toEqual({ ok: true, models: ['a'] });
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).has('Authorization')).toBe(false);
  });
  it('requires a model for a real test, but not discovery', async () => {
    const { service } = setup();
    expect(await service.command('server', { action: 'testConnection', accountId: 'alice', connection: { ...connection, id: undefined, model: undefined } }))
      .toEqual({ ok: false, code: 'invalid-input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects upstream credential echoes in test responses', async () => {
    fetcher.mockResolvedValue(response(connection.apiKey));
    await expect(testConnection({ connection, fetcher })).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
