import { describe, it, expect } from 'vitest';
import {
  mintBotToken,
  hashBotToken,
  isWellFormedBotToken,
  parseScopeList,
  isKnownScope,
  maskBotToken,
  BOT_TOKEN_PREFIX,
  BOT_SCOPES,
} from './botTokens.js';

describe('mintBotToken', () => {
  it('produces a well-formed token with prefix', () => {
    const { plaintext } = mintBotToken();
    expect(plaintext.startsWith(BOT_TOKEN_PREFIX)).toBe(true);
    expect(isWellFormedBotToken(plaintext)).toBe(true);
  });

  it('produces unique tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(mintBotToken().plaintext);
    expect(seen.size).toBe(100);
  });

  it('returns the sha256 hash that matches an independent recompute', () => {
    const { plaintext, tokenHash } = mintBotToken();
    expect(hashBotToken(plaintext)).toBe(tokenHash);
  });

  it('token hash is 64 hex characters (sha256)', () => {
    const { tokenHash } = mintBotToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('token prefix is the first 8 chars of plaintext', () => {
    const { plaintext, tokenPrefix } = mintBotToken();
    expect(tokenPrefix).toBe(plaintext.slice(0, 8));
  });
});

describe('hashBotToken', () => {
  it('is deterministic', () => {
    expect(hashBotToken('bsbot_AAAAAAAAAAAAAAAAAAAAAAAA')).toBe(
      hashBotToken('bsbot_AAAAAAAAAAAAAAAAAAAAAAAA'),
    );
  });

  it('produces a sha256 hex digest', () => {
    const h = hashBotToken('bsbot_AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different tokens hash differently', () => {
    const h1 = hashBotToken('bsbot_AAAAAAAAAAAAAAAAAAAAAAAA');
    const h2 = hashBotToken('bsbot_BBBBBBBBBBBBBBBBBBBBBBBB');
    expect(h1).not.toBe(h2);
  });
});

describe('isWellFormedBotToken', () => {
  it('accepts tokens with correct prefix and length', () => {
    const { plaintext } = mintBotToken();
    expect(isWellFormedBotToken(plaintext)).toBe(true);
  });
  it('rejects tokens without prefix', () => {
    expect(isWellFormedBotToken('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toBe(false);
  });
  it('rejects tokens of wrong length', () => {
    expect(isWellFormedBotToken('bsbot_SHORT')).toBe(false);
    expect(isWellFormedBotToken('bsbot_' + 'A'.repeat(31))).toBe(false);
    expect(isWellFormedBotToken('bsbot_' + 'A'.repeat(33))).toBe(false);
  });
});

describe('parseScopeList', () => {
  it('accepts known scopes', () => {
    const out = parseScopeList(['messages:read', 'messages:write']);
    expect(out).toEqual(['messages:read', 'messages:write']);
  });
  it('deduplicates', () => {
    expect(parseScopeList(['messages:read', 'messages:read'])).toEqual(['messages:read']);
  });
  it('rejects unknown scopes', () => {
    expect(() => parseScopeList(['admin:*'])).toThrow(/unknown scope/);
    expect(() => parseScopeList(['channels:read', 'ban:hammer'])).toThrow(/unknown scope/);
  });
  it('rejects non-array input', () => {
    expect(() => parseScopeList('messages:read')).toThrow(/array/);
    expect(() => parseScopeList({ 'messages:read': true })).toThrow(/array/);
  });
  it('rejects non-string entries', () => {
    expect(() => parseScopeList(['messages:read', 123])).toThrow(/strings/);
  });
  it('rejects admin-like scopes (not in catalog)', () => {
    for (const s of ['admin:*', 'admin:users', 'admin:federation', 'users:read']) {
      expect(isKnownScope(s)).toBe(false);
    }
  });
  it('catalog includes the issue-scoped actions', () => {
    expect(BOT_SCOPES).toContain('channels:read');
    expect(BOT_SCOPES).toContain('messages:read');
    expect(BOT_SCOPES).toContain('messages:write');
    expect(BOT_SCOPES).toContain('reactions:write');
    expect(BOT_SCOPES).toContain('threads:write');
    expect(BOT_SCOPES).toContain('attachments:write');
  });
});

describe('maskBotToken', () => {
  it('masks a full plaintext', () => {
    const { plaintext } = mintBotToken();
    const masked = maskBotToken(plaintext);
    expect(masked).toContain('...');
    expect(masked.length).toBeLessThan(plaintext.length);
  });
  it('returns short inputs unchanged', () => {
    expect(maskBotToken('bsbot_GE')).toBe('bsbot_GE');
  });
});
