import { describe, expect, it, vi } from 'vitest';
import { messageInput, messageOutput } from './messageLines';
import { TranslationService, TranslationVault, translateAi, protectText, restoreText, translationEligibility } from './index';
const source = 'Could you send me the meeting notes when you have time?\n(There is no rush, tomorrow is fine.)';
const translated = ['有空的话，能把会议记录发给我吗？', '（不着急，明天也行。）'];
const connection = { id: 'test', name: 'Test', baseUrl: 'https://api.example/v1', protocol: 'openai-chat' as const, model: 'chat', apiKey: '' };
const response = (value: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translation: value }) } }] });
describe('complete multi-line messages', () => {
  it('sends prose and parenthetical as one request and restores both lines', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(translated));
    expect(await translateAi({ connection, text: source, target: 'zh-CN', fetcher })).toBe(translated.join('\n'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const input = JSON.parse(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).messages[1].content);
    expect(input.untrustedText).toEqual(source.split('\n'));
  });
  it.each([translated[1], [translated[1]], ['', translated[1]], [null, translated[1]], [...translated, 'extra']])(
    'rejects incomplete or malformed line coverage %#', value => {
      expect(() => messageOutput(source, value)).toThrow('invalid-response');
    },
  );
  it('retains CRLF and blank lines without extra translation entries', () => {
    const source = 'First line.\r\n\r\n  \r\n(Aside.)\r\n';
    expect(messageInput(source)).toEqual(['First line.', '(Aside.)']);
    expect(messageOutput(source, ['第一行。', '（附注。）'])).toBe('第一行。\r\n\r\n  \r\n（附注。）\r\n');
  });
  it('keeps protected code and URLs intact across all lines', () => {
    const source = 'Please check https://example.com\n(Use \x60npm test\x60)\n\x60\x60\x60js\nconst name = "a";\n\x60\x60\x60';
    const prepared = protectText(source);
    expect(restoreText(messageOutput(prepared.text, messageInput(prepared.text)), prepared)).toBe(source);
  });
  it('does not let a long preferred-language aside hide foreign prose', () => {
    const source = 'Could you send me the meeting notes when you have time?\n（这只是我补充说明的一些内容，请保留英文正文的意思，不要只翻译这个括号里的说明。我们需要完整的消息。）';
    expect(translationEligibility(source, 'zh-CN')).toBeNull();
  });
  it('does not cache an aside-only response or retry it silently', async () => {
    let saved: string | null = null;
    const vault = new TranslationVault({ read: () => saved, write: (_scope, value) => { saved = value; } });
    const first = vault.saveConnection('server\nalice', { ...connection, id: undefined });
    const settings = vault.savePreferences('server\nalice', { ...first.preferences, targetLanguage: 'zh-CN', consent: true });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([translated[1]]));
    const cache = { get: vi.fn().mockReturnValue(null), set: vi.fn() };
    const service = new TranslationService(vault, fetcher, cache);
    expect(await service.command('server', { action: 'translate', accountId: 'alice', text: source, revision: settings.revision, automatic: false }))
      .toEqual({ ok: false, code: 'invalid-response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });
});
