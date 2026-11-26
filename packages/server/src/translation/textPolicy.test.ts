import { describe, expect, it } from 'vitest';
import { hasTranslatableText, protectText, restoreProtectedText, scanProtectedSpans } from './textPolicy.js';

describe('translation textPolicy (linear-time token protection)', () => {
  it('masks and restores code blocks, inline code, URLs, emails, mentions, and stickers', () => {
    const input =
      '请看 `npm test` 和 https://example.com/docs?x=1, 联系 dev+ops@example.org 或 <@12345> @alice ```ts\nconst x = "$&";\n```';
    const prepared = protectText(input);

    expect(prepared.text).not.toContain('npm test');
    expect(prepared.text).not.toContain('https://example.com');
    expect(prepared.text).not.toContain('dev+ops@example.org');
    expect(prepared.text).not.toContain('<@12345>');
    expect(prepared.text).not.toContain('@alice');
    expect(prepared.text).not.toContain('const x');
    expect(prepared.protectedParts.size).toBe(6);

    const tokens = [...prepared.protectedParts.keys()];
    const translated = `Please check ${tokens[0]} and ${tokens[1]}, contact ${tokens[2]} or ${tokens[3]} ${tokens[4]} ${tokens[5]}`;
    expect(restoreProtectedText(translated, prepared)).toBe(
      'Please check `npm test` and https://example.com/docs?x=1, contact dev+ops@example.org or <@12345> @alice ```ts\nconst x = "$&";\n```',
    );
  });

  it('rejects output when a placeholder is omitted or duplicated', () => {
    const prepared = protectText('访问 https://backspace.example 了解详情');
    expect(() => restoreProtectedText('Visit for details', prepared)).toThrow();
    const [token] = [...prepared.protectedParts.keys()];
    expect(() => restoreProtectedText(`Visit ${token} and ${token}`, prepared)).toThrow();
  });

  it('skips code-only, URL-only, and emoji-only messages', () => {
    expect(hasTranslatableText('https://example.com/path')).toBe(false);
    expect(hasTranslatableText('```js\nconsole.log(1)\n```')).toBe(false);
    expect(hasTranslatableText('🎉🚀✨')).toBe(false);
    expect(hasTranslatableText('{"only":"json"}')).toBe(false);
    expect(hasTranslatableText('你好 world')).toBe(true);
  });

  it('processes adversarial repetitive inputs in linear time without backtracking', () => {
    const plusFlood = `${'+'.repeat(5_500)}@example.com hello`;
    const stickerFlood = `${'[sticker:'.repeat(600)} hello`;

    const start = performance.now();
    scanProtectedSpans(plusFlood);
    scanProtectedSpans(stickerFlood);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(100);
  });
});
