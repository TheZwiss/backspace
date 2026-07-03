import { buildFederationHeaders, verifySignature, getOurOrigin } from './federationAuth.js';

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
    res = await fetch(`${peer.origin}/api/federation/verify-attach-proof`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
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

/**
 * Fetch the home instance's current profile for a native user via the
 * existing POST /api/federation/users/by-home-id endpoint. Best-effort:
 * null on any failure — re-attach proceeds without an initial profile
 * (the next profile_update relay fills it).
 */
export async function fetchHomeProfileByHomeId(
  peer: PeerForAttach,
  homeUserId: string,
): Promise<{ username: string; profile: { displayName: string | null; avatar: string | null; avatarColor: string | null; banner: string | null; bio: string | null } } | null> {
  const body = JSON.stringify({ homeUserId });
  const headers = buildFederationHeaders(body, peer.hmacSecret, getOurOrigin());

  let res: Response;
  try {
    res = await fetch(`${peer.origin}/api/federation/users/by-home-id`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  try {
    const parsed = await res.json() as {
      found?: boolean;
      user?: { username?: string; profile?: { displayName?: string | null; avatar?: string | null; avatarColor?: string | null; banner?: string | null; bio?: string | null } };
    };
    if (!parsed.found || !parsed.user || typeof parsed.user.username !== 'string' || !parsed.user.profile) return null;
    const p = parsed.user.profile;
    return {
      username: parsed.user.username,
      profile: {
        displayName: p.displayName ?? null,
        avatar: p.avatar ?? null,
        avatarColor: p.avatarColor ?? null,
        banner: p.banner ?? null,
        bio: p.bio ?? null,
      },
    };
  } catch {
    return null;
  }
}
