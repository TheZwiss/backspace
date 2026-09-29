import { buildFederationHeaders, verifySignature, getOurOrigin } from './federationAuth.js';
import { federationFetch } from './federationFetch.js';

export interface PeerForAttach {
  origin: string;
  hmacSecret: string;
}

/**
 * Verify a one-time attach-proof token with the detached account's home
 * instance (re-attach spec §3.1). The response body is only trusted when its
 * HMAC signature verifies against the shared peer secret — mirrors
 * fetchPeerEpoch. Any failure (network, bad status, bad signature, malformed
 * body) is treated as { valid: false }: re-attach fails closed.
 */
export async function verifyAttachProofWithPeer(
  peer: PeerForAttach,
  token: string,
): Promise<{ valid: true; homeUserId: string; username: string } | { valid: false }> {
  const body = JSON.stringify({ token });
  const headers = buildFederationHeaders(body, peer.hmacSecret, getOurOrigin());

  let res: Response;
  try {
    res = await federationFetch(peer.origin, '/api/federation/verify-attach-proof', {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    }, 'approved');
  } catch {
    return { valid: false };
  }
  if (!res.ok) return { valid: false };

  let text: string;
  try {
    text = await res.text();
  } catch {
    return { valid: false };
  }

  // Verify the response signature with the SAME secret and arg order the peer's
  // handler signed it with (buildFederationHeaders). A mismatch means we must
  // not trust the body — never trust an unauthenticated body (spec §2).
  const sig = (res.headers.get('x-federation-signature') ?? '').replace(/^sha256=/, '');
  const ts = Number(res.headers.get('x-federation-timestamp'));
  const nonce = res.headers.get('x-federation-nonce');
  if (!sig || !Number.isFinite(ts) || !verifySignature(text, sig, peer.hmacSecret, ts, nonce)) {
    return { valid: false };
  }

  try {
    const parsed = JSON.parse(text) as { valid?: boolean; homeUserId?: string; username?: string };
    if (parsed.valid === true && typeof parsed.homeUserId === 'string' && typeof parsed.username === 'string') {
      return { valid: true, homeUserId: parsed.homeUserId, username: parsed.username };
    }
  } catch {
    // fall through
  }
  return { valid: false };
}
