import { describe, it, expect } from 'vitest';
import { contentMentionsAny, splitMentionTokens } from './mentionTokens';

describe('splitMentionTokens', () => {
  it('splits a token out of the surrounding text', () => {
    expect(splitMentionTokens('hi <@U1> there')).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', userId: 'U1' },
      { kind: 'text', text: ' there' },
    ]);
  });

  it('keeps a token inside an inline code span as text', () => {
    expect(splitMentionTokens('see `<@U1>` and <@U2>')).toEqual([
      { kind: 'text', text: 'see `<@U1>` and ' },
      { kind: 'mention', userId: 'U2' },
    ]);
  });

  it('keeps a token inside a fenced block as text', () => {
    expect(splitMentionTokens('```\n<@U1>\n```')).toEqual([{ kind: 'text', text: '```\n<@U1>\n```' }]);
  });

  it('treats a token after an unclosed backtick as a mention', () => {
    expect(splitMentionTokens('a ` <@U1>')).toEqual([
      { kind: 'text', text: 'a ` ' },
      { kind: 'mention', userId: 'U1' },
    ]);
  });

  it('returns adjacent tokens without empty text between them', () => {
    expect(splitMentionTokens('<@A><@B>')).toEqual([
      { kind: 'mention', userId: 'A' },
      { kind: 'mention', userId: 'B' },
    ]);
  });

  it('returns nothing for empty content', () => {
    expect(splitMentionTokens('')).toEqual([]);
  });
});

describe('contentMentionsAny', () => {
  const ids = new Set(['me']);

  it('finds a token outside code', () => {
    expect(contentMentionsAny('hey <@me>', ids)).toBe(true);
  });

  it('ignores a token inside code', () => {
    expect(contentMentionsAny('the syntax is `<@me>`', ids)).toBe(false);
    expect(contentMentionsAny('```\n<@me>\n```', ids)).toBe(false);
  });

  it('ignores a token for another id', () => {
    expect(contentMentionsAny('hey <@someone>', ids)).toBe(false);
  });

  it('does not match an id that is only a prefix of the token id', () => {
    expect(contentMentionsAny('hey <@me2>', ids)).toBe(false);
  });
});
