import { describe, it, expect } from 'vitest';
import { CHANNEL_TOPIC_MAX_LENGTH, normalizeChannelTopic } from '@backspace/shared/src/constants.js';
import { checkChannelTopic } from './channelTopic.js';

describe('normalizeChannelTopic', () => {
  it('trims the value and keeps inner spacing and line breaks', () => {
    expect(normalizeChannelTopic('  Rules:\n  1. Be kind  ')).toBe('Rules:\n  1. Be kind');
  });

  it('unifies CRLF and CR line endings to LF', () => {
    expect(normalizeChannelTopic('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('turns a value that trims to nothing into null', () => {
    expect(normalizeChannelTopic('')).toBeNull();
    expect(normalizeChannelTopic(' \n\t\r\n ')).toBeNull();
  });
});

describe('checkChannelTopic', () => {
  it('accepts null as a clear', () => {
    expect(checkChannelTopic(null)).toEqual({ ok: true, topic: null });
  });

  it('accepts a string and returns its normalized form', () => {
    expect(checkChannelTopic('  hello\r\nworld ')).toEqual({ ok: true, topic: 'hello\nworld' });
  });

  it('refuses values that are neither a string nor null', () => {
    for (const raw of [42, true, {}, ['x'], undefined]) {
      expect(checkChannelTopic(raw)).toEqual({ ok: false, code: 'channel_topic_invalid' });
    }
  });

  it('accepts a topic of exactly the limit, counting after normalization', () => {
    const atLimit = 'x'.repeat(CHANNEL_TOPIC_MAX_LENGTH);
    expect(checkChannelTopic(`   ${atLimit}   `)).toEqual({ ok: true, topic: atLimit });
  });

  it('counts a CRLF line break as one character, as a textarea does', () => {
    const half = 'x'.repeat(CHANNEL_TOPIC_MAX_LENGTH / 2 - 1);
    const raw = `${half}\r\n${half}x`;
    expect(raw.length).toBe(CHANNEL_TOPIC_MAX_LENGTH + 1);
    expect(checkChannelTopic(raw)).toEqual({ ok: true, topic: `${half}\n${half}x` });
  });

  it('refuses a topic over the limit with the bound, instead of cutting it', () => {
    expect(checkChannelTopic('x'.repeat(CHANNEL_TOPIC_MAX_LENGTH + 1))).toEqual({
      ok: false,
      code: 'channel_topic_length',
      details: { max: CHANNEL_TOPIC_MAX_LENGTH },
    });
  });
});
