import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Two things are under test here, and they are two halves of one value.
 *
 * The parse half: `TRUSTED_PROXY_HOPS` is read at module load, so each case
 * sets the variable and re-imports a fresh `config`, the way `config.test.ts`
 * does. A junk value has to refuse the import, because that is what "refuses
 * to boot" means for a module the server imports before it listens.
 *
 * The address half: what the parsed number does to `request.ip`, which is the
 * key every rate limit in the app is billed to. Those cases build a Fastify
 * instance exactly as `index.ts` does. `app.inject` gives every request a
 * loopback socket address, which stands in for the fronting proxy in the
 * forwarded cases and for the client itself in the direct one.
 */
async function loadHops(): Promise<number> {
  vi.resetModules();
  const mod = await import('./config.js');
  return mod.config.trustedProxyHops;
}

async function clientAddress(headers: Record<string, string>, hops: number): Promise<string> {
  const app: FastifyInstance = Fastify({ trustProxy: hops });
  app.get('/whoami', async (request) => ({ ip: request.ip }));
  try {
    const response = await app.inject({ method: 'GET', url: '/whoami', headers });
    const body: unknown = JSON.parse(response.body);
    const { ip } = body as { ip: string };
    return ip;
  } finally {
    await app.close();
  }
}

const saved = process.env.TRUSTED_PROXY_HOPS;

beforeEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

afterEach(() => {
  if (saved === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = saved;
});

describe('TRUSTED_PROXY_HOPS', () => {
  it('defaults to one trusted hop when the variable is unset', async () => {
    expect(await loadHops()).toBe(1);
  });

  it('takes a number an operator set', async () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    expect(await loadHops()).toBe(2);
  });

  it('takes zero, which is the deployment with nothing in front', async () => {
    process.env.TRUSTED_PROXY_HOPS = '0';
    expect(await loadHops()).toBe(0);
  });

  it('tolerates surrounding whitespace, which a compose file can leave behind', async () => {
    process.env.TRUSTED_PROXY_HOPS = ' 2 ';
    expect(await loadHops()).toBe(2);
  });

  it('reads a blank value as unset rather than refusing to boot', async () => {
    // `TRUSTED_PROXY_HOPS=` is what an operator types to un-set a line, and it
    // is what an env_file passes through. It carries no number, so there is no
    // choice being silently discarded: this is the same "no opinion" an absent
    // variable expresses, and `envOptional` treats blank the same way.
    process.env.TRUSTED_PROXY_HOPS = '';
    expect(await loadHops()).toBe(1);
    // A line left with a space after the '=' is the same gesture.
    process.env.TRUSTED_PROXY_HOPS = '   ';
    expect(await loadHops()).toBe(1);
  });

  it('takes the cap, which is more hops than any deployment we know of', async () => {
    process.env.TRUSTED_PROXY_HOPS = '4';
    expect(await loadHops()).toBe(4);
  });

  it('refuses one hop above the cap, naming the value, the cap and what the number is', async () => {
    // A slip of the finger (11 for 1) would otherwise trust the whole
    // forwarded chain on a one-proxy instance, which is the behaviour this
    // setting exists to remove, and it would do it on an instance whose
    // operator believes they configured it.
    process.env.TRUSTED_PROXY_HOPS = '5';
    await expect(loadHops()).rejects.toThrow(/Got 5; the maximum is 4/);
    await expect(loadHops()).rejects.toThrow(/proxies in front of this app/);
    // The cap, not the operator's topology, is what to argue with, and the
    // message has to say so in a way that works for someone running the
    // published image with no checkout to open.
    await expect(loadHops()).rejects.toThrow(/that is the limit to raise and not your setting/);
    await expect(loadHops()).rejects.toThrow(/open an issue at https:\/\/github\.com\/[^\s]+\/issues/);
    await expect(loadHops()).rejects.not.toThrow(/packages\/server\/src\/config\.ts/);
  });

  it('refuses a typo that would restore the old trust-everything behaviour', async () => {
    process.env.TRUSTED_PROXY_HOPS = '11';
    await expect(loadHops()).rejects.toThrow(/Got 11; the maximum is 4/);
  });

  it.each([
    ['not a number', 'one'],
    ['a fraction', '1.5'],
    ['a negative', '-1'],
    ['digits with a suffix', '2 hops'],
  ])('refuses to boot on %s rather than falling back to the default', async (_label, value) => {
    process.env.TRUSTED_PROXY_HOPS = value;
    // The failure has to be the refusal, not a quiet 1: an operator who
    // mistyped the number would otherwise be told nothing and would run a
    // setting they did not choose.
    await expect(loadHops()).rejects.toThrow(/TRUSTED_PROXY_HOPS must be a non-negative integer/);
  });
});

describe('the client address rate limits are keyed on', () => {
  it('ignores a forged entry in front of the one the proxy appended', async () => {
    // nginx's `$proxy_add_x_forwarded_for`, which install.sh prints for proxy
    // mode, appends the peer it actually saw to whatever the client sent. The
    // client's claim is the left entry and must not become the key, or anyone
    // can rotate their own budget per request.
    expect(await clientAddress({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }, await loadHops())).toBe('203.0.113.7');
  });

  it('ignores a forged chain however long, and keys on the appended address', async () => {
    expect(await clientAddress({
      'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7',
    }, await loadHops())).toBe('203.0.113.7');
  });

  it('reads the address a proxy that overwrites the header leaves behind', async () => {
    // The bundled Caddy replaces the header rather than appending to it, so
    // the single entry is both the real client and the nearest hop's word.
    expect(await clientAddress({ 'x-forwarded-for': '203.0.113.7' }, await loadHops())).toBe('203.0.113.7');
  });

  it('falls back to the socket address when no forwarded header arrives', async () => {
    expect(await clientAddress({}, await loadHops())).toBe('127.0.0.1');
  });

  it('keys on the nearer proxy when a second one is in front and the count says one', async () => {
    // A CDN in front of the operator's own proxy is two hops. At the default
    // of one, the key is the inner proxy's view of its peer, so everyone
    // behind that CDN shares a budget: the operator's cue to set 2.
    expect(await clientAddress({ 'x-forwarded-for': '203.0.113.7, 10.0.0.9' }, await loadHops())).toBe('10.0.0.9');
    expect(await clientAddress({ 'x-forwarded-for': '203.0.113.7, 10.0.0.9' }, 2)).toBe('203.0.113.7');
  });

  it('at zero hops ignores the header entirely, which is the directly exposed case', async () => {
    // The residue the default cannot close on its own: with one trusted hop, a
    // lone entry is indistinguishable from a proxy's word, so an instance
    // exposed with no proxy in front trusts what the client sent. Zero is the
    // setting for that deployment, and it reads the socket address whatever
    // the client claims.
    expect(await clientAddress({ 'x-forwarded-for': '9.9.9.9' }, 1)).toBe('9.9.9.9');
    expect(await clientAddress({ 'x-forwarded-for': '9.9.9.9' }, 0)).toBe('127.0.0.1');
  });
});
