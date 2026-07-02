import { describe, it, expect, vi, afterEach } from 'vitest';
import { signRequest } from './federationAuth.js';

const PEER = { origin: 'https://orbit.test', hmacSecret: 'b'.repeat(64) };

function signedResponse(bodyObj: object): Response {
  const body = JSON.stringify(bodyObj);
  const ts = Date.now();
  const nonce = 'resp-nonce';
  const sig = signRequest(body, PEER.hmacSecret, ts, nonce);
  return new Response(body, {
    status: 200,
    headers: {
      'x-federation-signature': `sha256=${sig}`,
      'x-federation-timestamp': String(ts),
      'x-federation-nonce': nonce,
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('verifyAttachProofWithPeer', () => {
  it('returns the verified identity for a signed valid:true response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => signedResponse({ valid: true, homeUserId: 'h1', username: 'youruser' })));
    const { verifyAttachProofWithPeer } = await import('./federationAttach.js');
    const result = await verifyAttachProofWithPeer(PEER, 'a'.repeat(64));
    expect(result).toEqual({ valid: true, homeUserId: 'h1', username: 'youruser' });
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://orbit.test/api/federation/verify-attach-proof');
    expect((call[1] as RequestInit).headers).toHaveProperty('X-Federation-Signature');
  });

  it('treats an UNSIGNED response as valid:false (never trust unauthenticated bodies)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ valid: true, homeUserId: 'h1', username: 'youruser' }), { status: 200 })));
    const { verifyAttachProofWithPeer } = await import('./federationAttach.js');
    expect(await verifyAttachProofWithPeer(PEER, 'a'.repeat(64))).toEqual({ valid: false });
  });

  it('network error → valid:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const { verifyAttachProofWithPeer } = await import('./federationAttach.js');
    expect(await verifyAttachProofWithPeer(PEER, 'a'.repeat(64))).toEqual({ valid: false });
  });
});

describe('fetchHomeProfileByHomeId', () => {
  it('returns the profile for found:true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      found: true,
      user: { homeUserId: 'h1', username: 'youruser', profile: { displayName: 'J', avatar: 'a.webp', avatarColor: 'coral', banner: null, bio: null } },
    }), { status: 200 })));
    const { fetchHomeProfileByHomeId } = await import('./federationAttach.js');
    const result = await fetchHomeProfileByHomeId(PEER, 'h1');
    expect(result?.username).toBe('youruser');
    expect(result?.profile.avatar).toBe('a.webp');
  });

  it('found:false or network error → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ found: false }), { status: 200 })));
    const { fetchHomeProfileByHomeId } = await import('./federationAttach.js');
    expect(await fetchHomeProfileByHomeId(PEER, 'h1')).toBeNull();
  });
});
