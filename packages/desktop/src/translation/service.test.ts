import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { TranslationService } from '@backspace/translation';
import { TranslationVault } from './vault';
import { TranslationResultCache } from './resultCache';

let directory: string;
let vault: TranslationVault;
const origin = 'https://chat.example';
const scope = origin + '\nalice';
const fetcher = vi.fn<typeof fetch>();
let service: TranslationService;
let revision: number;
const response = () =>
  Response.json({
    choices: [{ finish_reason: 'stop', message: { content: '{"translation":"你好"}' } }],
  });
const command = () => ({
  action: 'translate',
  accountId: 'alice',
  text: 'Hello',
  revision,
  automatic: false,
});
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'backspace-service-'));
  vault = new TranslationVault(directory, {
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString(),
  });
  const settings = vault.saveConnection(scope, {
    name: 'test',
    protocol: 'openai-chat',
    baseUrl: 'https://api.example/v1',
    model: 'test',
    apiKey: 'private',
  });
  revision = vault.savePreferences(scope, {
    ...settings.preferences,
    targetLanguage: 'zh-CN',
    consent: true,
    automatic: true,
  }).revision;
  fetcher.mockReset().mockImplementation(async () => response());
  service = new TranslationService(
    vault,
    fetcher,
    new TranslationResultCache(path.join(directory, 'results'), {
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
    }),
  );
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('native translation policy', () => {
  it('translates with only the selected connection', async () => {
    expect(await service.command(origin, command())).toEqual({
      ok: true,
      result: { kind: 'translated', text: '你好' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never sends same-language or pure-code messages to the network', async () => {
    for (const text of ['这是一个中文消息。', '```js\nconst name = "hello";```']) {
      expect(await service.command(origin, { ...command(), text })).toMatchObject({
        ok: true,
        result: { kind: 'skipped' },
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('enforces consent and settings revision before any request', async () => {
    expect(await service.command(origin, { ...command(), revision: 0 })).toEqual({
      ok: false,
      code: 'stale-settings',
    });
    revision = vault.savePreferences(scope, {
      ...vault.read(scope).preferences,
      consent: false,
      automatic: false,
    }).revision;
    expect(await service.command(origin, command())).toEqual({
      ok: false,
      code: 'consent-required',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('serialises per account and discards a response after configuration changes', async () => {
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = service.command(origin, command());
    expect(await service.command(origin, { ...command(), text: 'Thanks' })).toEqual({
      ok: false,
      code: 'busy',
    });
    vault.savePreferences(scope, {
      ...vault.read(scope).preferences,
      targetLanguage: 'de',
    });
    finish(response());
    expect(await pending).toEqual({ ok: false, code: 'stale-settings' });
  });
  it('does not retry or silently fall back on an upstream failure', async () => {
    fetcher.mockResolvedValue(new Response('private error body', { status: 401 }));
    expect(await service.command(origin, command())).toEqual({
      ok: false,
      code: 'http',
      status: 401,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid IPC and separates accounts', async () => {
    expect(await service.command(origin, null)).toEqual({
      ok: false,
      code: 'invalid-input',
    });
    expect(await service.command(origin, { ...command(), accountId: '../../alice' })).toEqual({
      ok: false,
      code: 'invalid-input',
    });
    expect(await service.command(origin, { action: 'load', accountId: 'bob' })).toMatchObject({
      ok: true,
      settings: { connections: [] },
    });
  });
});

describe('avoiding repeated billable work', () => {
  it('reuses completed text after restart, key rotation and display changes', async () => {
    await service.command(origin, command());
    const saved = vault.read(scope);
    vault.saveConnection(scope, { ...saved.connections[0]!, name: 'renamed', apiKey: 'rotated' });
    revision = vault.savePreferences(scope, { ...saved.preferences, showOriginal: false }).revision;
    service = new TranslationService(
      vault,
      fetcher,
      new TranslationResultCache(path.join(directory, 'results'), {
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => value.toString(),
      }),
    );
    expect(await service.command(origin, command())).toMatchObject({ ok: true, result: { text: '你好' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('merges duplicate in-flight requests instead of charging twice or returning busy', async () => {
    let finish!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = service.command(origin, command());
    const second = service.command(origin, command());
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(response());
    expect(await second).toEqual(await first);
    expect(await first).toMatchObject({ ok: true });
  });
  it('retranslates edits but reuses an earlier body when edited back', async () => {
    await service.command(origin, command());
    await service.command(origin, { ...command(), text: 'Thanks' });
    await service.command(origin, command());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not reuse output from a different target or model', async () => {
    await service.command(origin, command());
    revision = vault.savePreferences(scope, {
      ...vault.read(scope).preferences,
      targetLanguage: 'de',
    }).revision;
    await service.command(origin, command());
    revision = vault.saveConnection(scope, {
      ...vault.read(scope).connections[0]!,
      model: 'different',
    }).revision;
    await service.command(origin, command());
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('retains validated work during a display-setting change while rejecting the stale caller', async () => {
    let finish!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = service.command(origin, command());
    revision = vault.savePreferences(scope, {
      ...vault.read(scope).preferences,
      showOriginal: false,
    }).revision;
    const current = service.command(origin, command());
    finish(response());
    expect(await first).toEqual({ ok: false, code: 'stale-settings' });
    expect(await current).toMatchObject({ ok: true });
    await service.command(origin, command());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('enforces consent even for cached results', async () => {
    await service.command(origin, command());
    revision = vault.savePreferences(scope, {
      ...vault.read(scope).preferences,
      consent: false,
      automatic: false,
    }).revision;
    expect(await service.command(origin, command())).toEqual({ ok: false, code: 'consent-required' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not cache failures and permits an explicit manual retry', async () => {
    fetcher.mockResolvedValueOnce(new Response('failure', { status: 500 }));
    expect(await service.command(origin, command())).toMatchObject({ ok: false });
    expect(await service.command(origin, command())).toMatchObject({ ok: true });
    await service.command(origin, command());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

it('reuses restored output using original text, not randomized protection placeholders', async () => {
  const text = 'Please check this useful link when you have time https://example.com/private';
  fetcher.mockImplementationOnce(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const source = JSON.parse(request.messages[1].content).untrustedText as string;
    const token = source.match(/__BS_[a-f0-9]+_\d+__/)![0];
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify({ translation: '请查看链接 ' + token }) },
        },
      ],
    });
  });
  const result = await service.command(origin, { ...command(), text });
  expect(result).toEqual({
    ok: true,
    result: { kind: 'translated', text: '请查看链接 https://example.com/private' },
  });
  expect(await service.command(origin, { ...command(), text })).toEqual(result);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not persist a pending translation after consent is revoked', async () => {
  let finish!: (value: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = service.command(origin, command());
  revision = vault.savePreferences(scope, {
    ...vault.read(scope).preferences,
    consent: false,
    automatic: false,
  }).revision;
  finish(response());
  expect(await pending).toEqual({ ok: false, code: 'stale-settings' });
  revision = vault.savePreferences(scope, { ...vault.read(scope).preferences, consent: true }).revision;
  await service.command(origin, command());
  expect(fetcher).toHaveBeenCalledTimes(2);
});
