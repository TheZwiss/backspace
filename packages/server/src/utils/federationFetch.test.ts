import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lookup = vi.fn<(host: string) => Promise<{ address: string; family: number }>>();
vi.mock('dns', () => ({ default: { promises: { lookup: (h: string) => lookup(h) } } }));

const allowPrivate = vi.fn<() => boolean>(() => false);
vi.mock('../config.js', () => ({
  config: { get federation() { return { allowPrivatePeers: allowPrivate() }; } },
}));

const { assertPeerOriginAllowed, federationFetch } = await import('./federationFetch.js');

// Block bodies, never concise arrows: a concise arrow returns the mock, and
// Vitest treats a value returned from a hook as a teardown callback it then
// invokes with no arguments after every test.
describe('assertPeerOriginAllowed', () => {
  beforeEach(() => {
    lookup.mockReset();
    allowPrivate.mockReset().mockReturnValue(false);
  });

  it('refuses a private address asserted by a stranger', async () => {
    lookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });
    await expect(assertPeerOriginAllowed('http://localhost:3000', 'asserted'))
      .rejects.toThrow(/not reachable on the public internet/);
  });

  it('refuses a v4-mapped private address asserted by a stranger', async () => {
    lookup.mockResolvedValue({ address: '::ffff:a9fe:a9fe', family: 6 });
    await expect(assertPeerOriginAllowed('https://metadata.test', 'asserted'))
      .rejects.toThrow(/not reachable on the public internet/);
  });

  it('refuses an asserted origin that does not resolve', async () => {
    lookup.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    await expect(assertPeerOriginAllowed('https://gone.test', 'asserted'))
      .rejects.toThrow(/did not resolve/);
  });

  it('allows a public address asserted by a stranger', async () => {
    lookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    await expect(assertPeerOriginAllowed('https://peer.test', 'asserted')).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith('peer.test');
  });

  it('allows a private address for a peer an admin approved', async () => {
    lookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });
    await expect(assertPeerOriginAllowed('http://localhost:3000', 'approved')).resolves.toBeUndefined();
    // The approved path must not spend a DNS round trip it does not need. This
    // also pins that 'approved' short-circuits rather than merely tolerating
    // whatever the resolver happened to answer.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('allows a private asserted address once the operator opts in', async () => {
    allowPrivate.mockReturnValue(true);
    lookup.mockResolvedValue({ address: '192.168.1.50', family: 4 });
    await expect(assertPeerOriginAllowed('http://nas.local:3000', 'asserted')).resolves.toBeUndefined();
  });

  it('strips brackets from an IPv6 literal origin before resolving', async () => {
    lookup.mockImplementation(async (host: string) => {
      if (host.startsWith('[')) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      return { address: host, family: 6 };
    });
    await expect(assertPeerOriginAllowed('http://[::1]:3000', 'asserted'))
      .rejects.toThrow(/not reachable on the public internet/);
    expect(lookup).toHaveBeenCalledWith('::1');
  });

  it('refuses a non-http scheme at either trust level', async () => {
    for (const trust of ['approved', 'asserted'] as const) {
      await expect(assertPeerOriginAllowed('file:///etc/passwd', trust)).rejects.toThrow(/scheme/i);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses an unparseable origin at either trust level', async () => {
    for (const trust of ['approved', 'asserted'] as const) {
      await expect(assertPeerOriginAllowed('not a url', trust)).rejects.toThrow(/Invalid peer origin/);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses an origin carrying a path, query or fragment', async () => {
    await expect(assertPeerOriginAllowed('https://peer.test/api/x', 'approved')).rejects.toThrow(/origin/i);
    await expect(assertPeerOriginAllowed('https://peer.test?a=1', 'approved')).rejects.toThrow(/origin/i);
    await expect(assertPeerOriginAllowed('https://peer.test#f', 'approved')).rejects.toThrow(/origin/i);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('federationFetch', () => {
  const transport = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    lookup.mockReset();
    allowPrivate.mockReset().mockReturnValue(false);
    transport.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', transport);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not issue the request when the gate refuses the origin', async () => {
    lookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });
    await expect(
      federationFetch('http://localhost:3000', '/api/federation/relay', { method: 'POST' }, 'asserted'),
    ).rejects.toThrow(/not reachable on the public internet/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('joins the path onto the origin and keeps the caller init', async () => {
    lookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    const signal = AbortSignal.timeout(5_000);
    await federationFetch(
      'https://peer.test',
      '/api/federation/relay',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal },
      'asserted',
    );
    expect(transport).toHaveBeenCalledTimes(1);
    const [target, init] = transport.mock.calls[0]!;
    expect(target).toBe('https://peer.test/api/federation/relay');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(init?.signal).toBe(signal);
  });

  it('does not follow redirects', async () => {
    lookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    transport.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9200/x' } }),
    );
    const res = await federationFetch('https://peer.test', '/api/federation/epoch', {}, 'approved');
    expect(res.status).toBe(302);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]?.redirect).toBe('manual');
  });
});
