import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lookup = vi.fn<(host: string) => Promise<{ address: string; family: number }>>();
vi.mock('dns', () => ({ default: { promises: { lookup: (h: string) => lookup(h) } } }));

const { validateExternalUrl, isPrivateIp } = await import('./ssrf.js');

describe('isPrivateIp', () => {
  it('still answers the addresses it always answered', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('answers the ones it used to miss', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::', '100.64.0.1', 'fe9a::1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
});

describe('validateExternalUrl', () => {
  // Block bodies, not concise arrows: a hook that RETURNS a function has that
  // function registered as a teardown callback and invoked with no arguments at
  // the end of the test. `mockReset()` returns the mock, so `() => m.mockReset()`
  // silently calls the mock once per test — which an implementation that reads
  // its argument then trips over.
  beforeEach(() => {
    lookup.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a hostname whose AAAA record is a v4-mapped loopback', async () => {
    lookup.mockResolvedValue({ address: '::ffff:7f00:1', family: 6 });
    await expect(validateExternalUrl('https://rebind.example/x')).rejects.toThrow('Private IP not allowed');
  });

  it('rejects a hostname resolving into CGNAT', async () => {
    lookup.mockResolvedValue({ address: '100.64.9.9', family: 4 });
    await expect(validateExternalUrl('https://cgnat.example/x')).rejects.toThrow('Private IP not allowed');
  });

  it('accepts a public address', async () => {
    lookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    await expect(validateExternalUrl('https://example.com/x')).resolves.toBeUndefined();
  });

  it('strips brackets before resolving, so an IPv6 literal is understood rather than accidentally ENOTFOUND', async () => {
    lookup.mockImplementation(async (host: string) => {
      // The old code passed '[::1]' straight to dns.lookup, which threw
      // ENOTFOUND and produced the right answer for the wrong reason.
      if (host.startsWith('[')) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      return { address: host, family: 6 };
    });
    await expect(validateExternalUrl('http://[::1]/x')).rejects.toThrow('Private IP not allowed');
    expect(lookup).toHaveBeenCalledWith('::1');
  });

  it('lets a public IPv6 literal through, which it could not before', async () => {
    lookup.mockImplementation(async (host: string) => ({ address: host, family: 6 }));
    await expect(validateExternalUrl('https://[2606:4700::1111]/x')).resolves.toBeUndefined();
    // The resolve alone is not evidence: with a doubled resolver the old code
    // also resolved, because the bracketed string matched none of its prefixes.
    // What the old code could not do is hand the resolver an address it could
    // actually look up, so assert on the argument.
    expect(lookup).toHaveBeenCalledWith('2606:4700::1111');
  });

  it('refuses non-http schemes before touching DNS', async () => {
    await expect(validateExternalUrl('file:///etc/passwd')).rejects.toThrow('Invalid URL scheme');
    expect(lookup).not.toHaveBeenCalled();
  });
});
