import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('dotenv', () => ({ config: vi.fn() }));

const ALLOWLIST = '192.0.2.2, 198.51.100.0/24, 2001:db8:2::/64';

async function loadConfig(hops?: string, addresses?: string) {
  vi.stubEnv('TRUSTED_PROXY_HOPS', hops);
  vi.stubEnv('TRUSTED_PROXY_ADDRESSES', addresses);
  vi.resetModules();
  return (await import('./config.js')).config;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function requestAddress({
  hops,
  peer = '192.0.2.2',
  chain,
}: { hops?: string; peer?: string; chain?: string }) {
  const { trustProxy } = await loadConfig(hops, ALLOWLIST);
  const app = Fastify({ trustProxy });
  app.get('/', async ({ ip, hostname, protocol }) => ({ ip, hostname, protocol }));
  try {
    return (await app.inject({
      url: '/',
      remoteAddress: peer,
      headers: {
        host: 'internal.example',
        'x-forwarded-host': 'public.example',
        'x-forwarded-proto': 'https',
        ...(chain && { 'x-forwarded-for': chain }),
      },
    })).json<{ ip: string; hostname: string; protocol: string }>();
  } finally {
    await app.close();
  }
}

describe('proxy startup configuration', () => {
  it.each([undefined, '', '   '])('requires proxy addresses when hops default to one (%s)', async (hops) => {
    await expect(loadConfig(hops)).rejects.toThrow(/TRUSTED_PROXY_ADDRESSES.*TRUSTED_PROXY_HOPS=0/);
  });

  it('defaults development to direct access with no proxy configured', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await loadConfig()).trustProxy).toBe(false);
  });

  it('allows explicit proxy configuration in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { trustProxy } = await loadConfig(undefined, ALLOWLIST);
    expect(trustProxy && trustProxy('192.0.2.2', 0)).toBe(true);
    expect(trustProxy && trustProxy('198.51.100.9', 1)).toBe(false);
    await expect(loadConfig('1')).rejects.toThrow(/TRUSTED_PROXY_ADDRESSES/);
  });

  it('requires proxy addresses when upgrading a deployment with an existing hop count', async () => {
    await expect(loadConfig('2', ' ')).rejects.toThrow(/TRUSTED_PROXY_ADDRESSES.*TRUSTED_PROXY_HOPS=0/);
  });

  it('supports explicit direct access', async () => {
    expect((await loadConfig('0')).trustProxy).toBe(false);
  });

  it('accepts the maximum hop count and IPv4-mapped proxy rules', async () => {
    const { trustProxy } = await loadConfig(' 4 ', '::ffff:192.0.2.8, ::ffff:198.51.100.0/120');
    expect(trustProxy && trustProxy('192.0.2.8', 3)).toBe(true);
    expect(trustProxy && trustProxy('::ffff:198.51.100.8', 3)).toBe(true);
    expect(trustProxy && trustProxy('198.51.100.8', 4)).toBe(false);
  });

  it.each(['one', '1.5', '-1', '2 hops'])('rejects a malformed hop count (%s)', async (hops) => {
    await expect(loadConfig(hops, ALLOWLIST)).rejects.toThrow(/TRUSTED_PROXY_HOPS must be a non-negative integer/);
  });

  it.each(['5', '11'])('rejects a hop count over four (%s)', async (hops) => {
    await expect(loadConfig(hops, ALLOWLIST)).rejects.toThrow(new RegExp(`Got ${hops}; the maximum is 4`));
  });

  it.each(['proxy.example', '192.0.2.2,', '192.0.2.2/33', '192.0.2.2/1.5', '2001:db8::/129',
    '192.0.2.2/24/7', '0.0.0.0/0', '::/0', '::ffff:192.0.2.2/96'])(
    'rejects a malformed or unrestricted proxy rule (%s)',
    async (rule) => {
      await expect(loadConfig('1', rule)).rejects.toThrow(/TRUSTED_PROXY_ADDRESSES/);
    },
  );
});

describe('the client address used by HTTP and WebSocket rate limits', () => {
  it('uses the nearest approved proxy by default', async () => {
    expect(await requestAddress({ chain: '203.0.113.7, 198.51.100.9' })).toEqual({
      ip: '198.51.100.9',
      hostname: 'public.example',
      protocol: 'https',
    });
  });

  it('accepts a second approved proxy when the cap allows it', async () => {
    expect((await requestAddress({ hops: '2', chain: '203.0.113.7, 198.51.100.9' })).ip).toBe('203.0.113.7');
  });

  it('stops at the first peer outside the allowlist', async () => {
    expect((await requestAddress({ hops: '2', chain: '203.0.113.7, 192.0.2.9' })).ip).toBe('192.0.2.9');
  });

  it('uses socket metadata with an unapproved immediate peer', async () => {
    expect(await requestAddress({ peer: '192.0.2.9', chain: '203.0.113.7' })).toEqual({
      ip: '192.0.2.9',
      hostname: 'internal.example',
      protocol: 'http',
    });
  });

  it('uses socket metadata at zero hops', async () => {
    expect(await requestAddress({ hops: '0', chain: '203.0.113.7' })).toEqual({
      ip: '192.0.2.2',
      hostname: 'internal.example',
      protocol: 'http',
    });
  });

  it.each(['2001:db8:2::a', '::ffff:192.0.2.2'])('accepts approved IPv6 and mapped addresses (%s)', async (peer) => {
    expect((await requestAddress({ peer, chain: '203.0.113.7' })).ip).toBe('203.0.113.7');
  });

  it('uses the socket when the approved peer sends no forwarded metadata', async () => {
    expect((await requestAddress({})).ip).toBe('192.0.2.2');
  });
});
