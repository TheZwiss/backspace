import { describe, expect, it } from 'vitest';
import { naturalText, protectText, restoreText, translationEligibility } from './index';
import { baseUrl, connectionInput, preferencesInput } from './index';
import { DEFAULT_PREFERENCES } from './vault';

describe('local translation eligibility', () => {
  it.each(['你好，这是一个中文聊天消息。', '這是一段繁體中文消息。'])(
    'skips preferred Chinese locally: %s',
    (text) => {
      expect(translationEligibility(text, 'zh-CN')).toEqual({
        kind: 'skipped',
        reason: 'same-language',
      });
    },
  );
  it.each(['Hello', 'Thank you!', 'This is an English message about our meeting tomorrow.'])(
    'recognises English: %s',
    (text) => {
      expect(translationEligibility(text, 'en')).toEqual({
        kind: 'skipped',
        reason: 'same-language',
      });
      expect(translationEligibility(text, 'zh-CN')).toBeNull();
    },
  );
  it.each([
    '😀 123',
    'https://example.com/hello',
    'sticker:https://example.com/cat.gif',
    '```js\nconst hello = "world";\n```',
    '`hello()`',
    'const greeting = "hello world";',
    '{"message":"hello world"}',
    'console.log("hello world");',
    '<@12345>',
  ])('does not send non-prose: %s', (text) => {
    expect(translationEligibility(text, 'zh-CN')).toEqual({
      kind: 'skipped',
      reason: 'not-text',
    });
  });
  it.each(['OK', 'bonjour', 'xyz'])('does not send ambiguous short text: %s', (text) => {
    expect(translationEligibility(text, 'en')).toEqual({
      kind: 'skipped',
      reason: 'uncertain-language',
    });
  });
  it('recognises longer Japanese and Korean prose', () => {
    expect(translationEligibility('こんにちは、明日の会議について確認してください。', 'ja')).toEqual({
      kind: 'skipped',
      reason: 'same-language',
    });
    expect(translationEligibility('안녕하세요 내일 회의 일정을 확인해 주세요.', 'ko')).toEqual({
      kind: 'skipped',
      reason: 'same-language',
    });
  });
});

describe('protected message fragments', () => {
  it('masks code, links, email and mentions and restores literal dollars', () => {
    const source = 'Please read `$&` https://example.com user@example.com <@123>.';
    const prepared = protectText(source);
    expect(prepared.text).not.toContain('example.com');
    expect(prepared.text).not.toContain('$&');
    expect(naturalText(source)).toContain('Please read');
    expect(restoreText(prepared.text, prepared)).toBe(source);
  });
  it('rejects lost, duplicated or invented placeholders', () => {
    const prepared = protectText('Read `hello()`');
    const token = [...prepared.protectedParts.keys()][0]!;
    expect(() => restoreText('lost', prepared)).toThrow('protected-content');
    expect(() => restoreText(token + token, prepared)).toThrow('protected-content');
    expect(() => restoreText(prepared.text + '__BS_1234567890abcdef_9__', prepared)).toThrow(
      'protected-content',
    );
  });
});

describe('configuration boundary', () => {
  it.each([
    'http://remote.example/v1',
    'https://secret@api.example',
    'https://api.example?key=secret',
    'https://api.example/#secret',
    'file:///tmp/api',
  ])('rejects unsafe URL %s', (url) => {
    expect(() => baseUrl(url)).toThrow('invalid-input');
  });
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234',
    'http://[::1]:1234',
    'https://api.example/v1',
  ])('accepts secure or loopback URL %s', (url) => {
    expect(baseUrl(url + '/')).toBe(url);
  });
  it('rejects header injection, unknown protocols and invalid preferences', () => {
    const input = {
      name: 'test',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example/v1',
      model: 'test',
      apiKey: 'secret\r\nx-bad: yes',
    };
    expect(() => connectionInput(input)).toThrow('invalid-input');
    expect(() => connectionInput({ ...input, apiKey: '', protocol: 'unknown' })).toThrow('invalid-input');
    expect(() => preferencesInput({ ...DEFAULT_PREFERENCES, automatic: 'true' })).toThrow('invalid-input');
  });
});
