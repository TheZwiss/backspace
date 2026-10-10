import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationSettings } from '@backspace/shared/translation';
import { serverTranslationBridge } from './serverBridge';
import { sendTranslationCommand } from './translationStore';
const runtime = vi.hoisted(() => ({ origin: 'https://home.example' }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { subscribe: vi.fn() } }));
const fetcher = vi.fn<typeof fetch>();
const settings: TranslationSettings = { revision: 0, connections: [], preferences: {
  defaultConnection: null, engine: null, automatic: false, consent: false, showOriginal: true, targetLanguage: 'en',
} };
const load = { action: 'load' as const, accountId: 'alice' };
beforeEach(() => {
  delete window.backspace;
  runtime.origin = 'https://home.example';
  localStorage.setItem('backspace_token', 'session-token');
  vi.stubGlobal('location', { get href() { return runtime.origin; } });
  fetcher.mockReset().mockResolvedValue(Response.json({ ok: true, settings }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { localStorage.removeItem('backspace_token'); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete window.backspace; });

describe('browser server translation transport', () => {
  it('works without the desktop bridge and sends only to the home API', async () => {
    expect(await sendTranslationCommand(load)).toEqual({ ok: true, settings });
    expect(fetcher).toHaveBeenCalledWith('https://home.example/api/translation/command', expect.objectContaining({
      method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
    }));
  });
  it('sends a new key only in the explicit save body, never browser storage', async () => {
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const connection = { name: 'Private', protocol: 'openai-chat' as const, model: 'translator', baseUrl: 'https://api.example/v1', apiKey: 'test-only-secret' };
    await serverTranslationBridge.command({ action: 'saveConnection', accountId: 'alice', connection });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ connection });
    expect(save).not.toHaveBeenCalled();
    expect(String(fetcher.mock.calls[0]![0])).not.toContain(connection.apiKey);
  });
  it('never switches to server after native failure', async () => {
    Object.defineProperty(window, 'backspace', { configurable: true, value: { translation: { command: vi.fn().mockRejectedValue(new Error('native unavailable')) } } });
    expect(await sendTranslationCommand(load)).toEqual({ ok: false, code: 'network' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['http://home.example', 'file:///app'])('rejects insecure transport %s', async origin => {
    runtime.origin = origin;
    expect(await serverTranslationBridge.command(load)).toEqual({ ok: false, code: 'insecure-transport' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['http://localhost:3005', 'http://127.0.0.1:3005', 'http://[::1]:3005'])('allows loopback development %s', async origin => {
    runtime.origin = origin;
    expect((await serverTranslationBridge.command(load)).ok).toBe(true);
  });
  it('rejects missing sessions without making a request', async () => {
    localStorage.removeItem('backspace_token');
    expect(await serverTranslationBridge.command(load)).toEqual({ ok: false, code: 'untrusted-sender' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { status: 401, code: 'untrusted-sender' }, { status: 403, code: 'untrusted-sender' },
    { status: 404, code: 'server-not-configured' }, { status: 429, code: 'http' },
  ])('reports HTTP $status without retries', async ({ status, code }) => {
    fetcher.mockResolvedValue(new Response('error', { status }));
    expect(await serverTranslationBridge.command(load)).toMatchObject({ ok: false, code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    null, { ok: true, settings: 'bad' }, { ok: true, result: { kind: 'translated', text: 42 } },
    { ok: true, settings: { ...settings, preferences: {} } }, { ok: false, code: 'unexpected-provider-error' },
  ])('rejects malformed replies %#', async body => {
    fetcher.mockResolvedValue(Response.json(body));
    expect(await serverTranslationBridge.command(load)).toEqual({ ok: false, code: 'invalid-response' });
  });
  it('rejects HTML and success JSON on a failing HTTP status', async () => {
    fetcher.mockResolvedValueOnce(new Response('<html>proxy failure</html>', { status: 502 }));
    expect(await serverTranslationBridge.command(load)).toEqual({ ok: false, code: 'invalid-response' });
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, settings }, { status: 500 }));
    expect(await serverTranslationBridge.command(load)).toEqual({ ok: false, code: 'http', status: 500 });
  });
  it('accepts translated/skipped results and explicit missing server setup', async () => {
    for (const result of [{ kind: 'translated', text: '译文' }, { kind: 'skipped', reason: 'same-language' }]) {
      fetcher.mockResolvedValueOnce(Response.json({ ok: true, result }));
      expect(await serverTranslationBridge.command(load)).toEqual({ ok: true, result });
    }
    fetcher.mockResolvedValueOnce(Response.json({ ok: false, code: 'server-not-configured' }, { status: 503 }));
    expect(await serverTranslationBridge.command(load)).toMatchObject({ ok: false, code: 'server-not-configured' });
  });
  it.each([{ name: 'TimeoutError', code: 'timeout' }, { name: 'TypeError', code: 'network' }])('classifies $name without retries', async ({ name, code }) => {
    fetcher.mockRejectedValue(Object.assign(new Error('private details'), { name }));
    expect(await serverTranslationBridge.command(load)).toEqual({ ok: false, code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
