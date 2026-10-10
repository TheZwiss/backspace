import { describe, expect, it } from 'vitest';
import { readServerReply } from './serverReply';

describe('diagnostic response boundary', () => {
  it('accepts model discovery and timing results without forwarding extra fields', () => {
    expect(readServerReply({ ok: true, models: ['chat-a'], apiKey: 'not-for-the-page' }))
      .toEqual({ ok: true, models: ['chat-a'] });
    expect(readServerReply({ ok: true, models: [] })).toEqual({ ok: true, models: [] });
    expect(readServerReply({ ok: true, test: { text: 'Hello!', latencyMs: 0, apiKey: 'not-for-the-page' } }))
      .toEqual({ ok: true, test: { text: 'Hello!', latencyMs: 0 } });
  });
  it.each([null, '<html>old server</html>', { ok: true }, { ok: true, models: {} },
    { ok: true, models: [1] }, { ok: true, models: [' '] }, { ok: true, models: ['bad\nmodel'] },
    { ok: true, models: ['a'.repeat(161)] }, { ok: true, models: Array(1001).fill('a') },
    { ok: true, test: { text: '', latencyMs: 1 } }, { ok: true, test: { text: 'x'.repeat(2001), latencyMs: 1 } },
    { ok: true, test: { text: 'Hello', latencyMs: -1 } }, { ok: true, test: { text: 'Hello', latencyMs: 1.5 } },
    { ok: true, test: { text: 'Hello', latencyMs: '1' } }, { ok: true, test: { text: 'Hello', latencyMs: Infinity } },
  ])('rejects malformed or oversized success payloads', value => {
    expect(readServerReply(value)).toEqual({ ok: false, code: 'invalid-response' });
  });
  it('keeps safe provider error codes and never exposes provider response bodies', () => {
    expect(readServerReply({ ok: false, code: 'http', status: 401, body: 'private upstream content' }))
      .toEqual({ ok: false, code: 'http', status: 401 });
    expect(readServerReply({ ok: false, code: 'arbitrary upstream error' }))
      .toEqual({ ok: false, code: 'invalid-response' });
  });
});
