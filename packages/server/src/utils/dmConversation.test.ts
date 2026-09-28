import { describe, it, expect } from 'vitest';
import { homeIdentityOf, mintGroupKey, oneOnOneKey } from './dmConversation.js';

describe('oneOnOneKey', () => {
  it('matches the vector the web client derives against, in either order', () => {
    // The same vector as packages/web/src/utils/dmConversationKey.test.ts: a
    // client that derives a key for a 1.6.1 peer must land on these bytes.
    const expected = 'fc8aa3239ccea0cd4cbfb7701d770ac9';
    const alice = { id: 'alice-home', homeUserId: null };
    const bobStub = { id: 'bob-stub', homeUserId: 'bob-remote' };
    expect(oneOnOneKey(alice, bobStub)).toBe(expected);
    expect(oneOnOneKey(bobStub, alice)).toBe(expected);
    // The copy on bob's instance: bob native, alice as a stub there.
    expect(oneOnOneKey({ id: 'bob-remote', homeUserId: null }, { id: 'alice-on-b', homeUserId: 'alice-home' })).toBe(expected);
  });

  it('is 32 lowercase hex characters', () => {
    expect(oneOnOneKey({ id: 'a', homeUserId: null }, { id: 'b', homeUserId: null })).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('homeIdentityOf', () => {
  it('is the home user id when there is one, else the local id', () => {
    expect(homeIdentityOf({ id: 'local', homeUserId: 'home' })).toBe('home');
    expect(homeIdentityOf({ id: 'local', homeUserId: null })).toBe('local');
    expect(homeIdentityOf({ id: 'local', homeUserId: '' })).toBe('local');
  });
});

describe('mintGroupKey', () => {
  it('mints a fresh UUID each time, never the 1-on-1 shape', () => {
    const a = mintGroupKey();
    const b = mintGroupKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/^[0-9a-f]{32}$/);
  });
});
