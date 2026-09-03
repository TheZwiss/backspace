import { describe, it, expect } from 'vitest';
import { buildInstanceJoinUrl } from './inviteParser';

const CODE = 'a3f1b2c4@origin.test';

describe('buildInstanceJoinUrl', () => {
  it('builds the join URL for a plain domain', () => {
    expect(buildInstanceJoinUrl('my-instance.com', CODE))
      .toBe(`https://my-instance.com/join/${encodeURIComponent(CODE)}`);
  });

  it('keeps an explicit port', () => {
    expect(buildInstanceJoinUrl('my-instance.com:8443', CODE))
      .toBe(`https://my-instance.com:8443/join/${encodeURIComponent(CODE)}`);
  });

  it('trims surrounding whitespace', () => {
    expect(buildInstanceJoinUrl('  my-instance.com  ', CODE))
      .toBe(`https://my-instance.com/join/${encodeURIComponent(CODE)}`);
  });

  it('accepts an internationalised domain and lets the parser punycode it', () => {
    expect(buildInstanceJoinUrl('münchen.de', CODE))
      .toBe(`https://xn--mnchen-3ya.de/join/${encodeURIComponent(CODE)}`);
  });

  it('accepts a bracketed IPv6 literal', () => {
    expect(buildInstanceJoinUrl('[fd00::1]', CODE))
      .toBe(`https://[fd00::1]/join/${encodeURIComponent(CODE)}`);
  });

  // The hazard the guard exists for. Plain concatenation reads the part before
  // the "@" as a userinfo section, so the browser goes to the host on the
  // right while the typed string starts with the name on the left.
  it('shows that plain concatenation sends a userinfo string somewhere else', () => {
    const naive = new URL(`https://my-instance.com@elsewhere.test/join/${encodeURIComponent(CODE)}`);
    expect(naive.host).toBe('elsewhere.test');
    expect(naive.username).toBe('my-instance.com');
  });

  it('refuses a value with a userinfo section', () => {
    expect(buildInstanceJoinUrl('my-instance.com@elsewhere.test', CODE)).toBeNull();
  });

  it('refuses a value carrying a path', () => {
    expect(buildInstanceJoinUrl('my-instance.com/anything', CODE)).toBeNull();
  });

  it('refuses a value carrying a query', () => {
    expect(buildInstanceJoinUrl('my-instance.com?next=x', CODE)).toBeNull();
  });

  it('refuses a value carrying a fragment', () => {
    expect(buildInstanceJoinUrl('my-instance.com#x', CODE)).toBeNull();
  });

  it('refuses a value carrying a backslash', () => {
    expect(buildInstanceJoinUrl('my-instance.com\\elsewhere.test', CODE)).toBeNull();
  });

  it('refuses a value that names its own scheme', () => {
    expect(buildInstanceJoinUrl('http://my-instance.com', CODE)).toBeNull();
    expect(buildInstanceJoinUrl('javascript:alert(1)', CODE)).toBeNull();
  });

  it('refuses an empty or whitespace-only value', () => {
    expect(buildInstanceJoinUrl('', CODE)).toBeNull();
    expect(buildInstanceJoinUrl('   ', CODE)).toBeNull();
  });
});
