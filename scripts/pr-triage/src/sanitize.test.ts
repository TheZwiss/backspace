import { describe, it, expect } from 'vitest';
import { inline, code, login, codeList } from './sanitize.ts';

describe('inline', () => {
  it('strips control characters and newlines', () => {
    expect(inline('a\nb\r\tc\x00d\x7fe')).toBe('abcde');
  });

  it('strips bidi and directional marks', () => {
    expect(inline('.github/workflows/\u202eci.yml\u202c\u200e')).toBe('.github/workflows/ci.yml');
  });

  it('neutralises backticks and pipes so a code span in a table cell survives', () => {
    expect(inline('a`b|c')).toBe("a'b/c");
  });

  it('truncates long values', () => {
    const long = 'x'.repeat(300);
    expect(inline(long)).toHaveLength(120);
    expect(inline(long).endsWith('…')).toBe(true);
  });

  it('never returns an empty string', () => {
    expect(inline('')).toBe('(empty)');
    expect(inline('\n\t')).toBe('(empty)');
  });
});

describe('code', () => {
  it('wraps the sanitised value in backticks', () => {
    expect(code('a`b')).toBe("`a'b`");
  });
});

describe('login', () => {
  it('accepts real logins and rejects everything else', () => {
    expect(login('akk0sfx')).toBe('akk0sfx');
    expect(login('st7105')).toBe('st7105');
    expect(login('a-b')).toBe('a-b');
    expect(login('')).toBeNull();
    expect(login('a b')).toBeNull();
    expect(login('@evil')).toBeNull();
    expect(login('x'.repeat(40))).toBeNull();
  });
});

describe('codeList', () => {
  it('caps the list and counts the rest', () => {
    const items = Array.from({ length: 12 }, (_, i) => `p${i}`);
    expect(codeList(items, 3)).toBe('`p0`, `p1`, `p2` and 9 more');
    expect(codeList(['a', 'b'], 3)).toBe('`a`, `b`');
    expect(codeList([], 3)).toBe('');
  });
});
