import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TRUSTED_PROXY_HOPS } from './trustedProxy.js';

/**
 * These cases are about the address every rate limit in the app is billed to.
 * They build a Fastify instance configured exactly as `index.ts` configures
 * the real one, so the shipped value of `TRUSTED_PROXY_HOPS` is what is under
 * test: putting `true` back, or raising the number past the hops a deployment
 * really has, fails here.
 *
 * `app.inject` gives every request a loopback socket address, which stands in
 * for the fronting proxy in the forwarded cases and for the client itself in
 * the direct one.
 */
async function clientAddress(headers: Record<string, string>, hops: number = TRUSTED_PROXY_HOPS): Promise<string> {
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

describe('the client address rate limits are keyed on', () => {
  it('ignores a forged entry in front of the one the proxy appended', async () => {
    // nginx's `$proxy_add_x_forwarded_for`, which install.sh prints for proxy
    // mode, appends the peer it actually saw to whatever the client sent. The
    // client's claim is the left entry and must not become the key, or anyone
    // can rotate their own budget per request.
    expect(await clientAddress({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' })).toBe('203.0.113.7');
  });

  it('ignores a forged chain however long, and keys on the appended address', async () => {
    expect(await clientAddress({
      'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7',
    })).toBe('203.0.113.7');
  });

  it('reads the address a proxy that overwrites the header leaves behind', async () => {
    // The bundled Caddy replaces the header rather than appending to it, so
    // the single entry is both the real client and the nearest hop's word.
    expect(await clientAddress({ 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('falls back to the socket address when no forwarded header arrives', async () => {
    expect(await clientAddress({})).toBe('127.0.0.1');
  });

  it('keys on the nearer proxy when a second one is in front and the count says one', async () => {
    // A CDN in front of the operator's own proxy is two hops. At one, the key
    // is the inner proxy's view of its peer, so everyone behind that CDN
    // shares a budget. A degradation, not a hole, and the operator's cue to
    // raise the number.
    expect(await clientAddress({ 'x-forwarded-for': '203.0.113.7, 10.0.0.9' })).toBe('10.0.0.9');
  });

  it('at zero hops ignores the header entirely, which is the directly exposed case', async () => {
    // The residue this number cannot close on its own: with one trusted hop,
    // a lone entry is indistinguishable from a proxy's word, so an instance
    // exposed with no proxy in front trusts what the client sent. Zero is the
    // setting for that deployment, and it reads the socket address whatever
    // the client claims.
    expect(await clientAddress({ 'x-forwarded-for': '9.9.9.9' }, 1)).toBe('9.9.9.9');
    expect(await clientAddress({ 'x-forwarded-for': '9.9.9.9' }, 0)).toBe('127.0.0.1');
  });
});
