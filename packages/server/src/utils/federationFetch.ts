import dns from 'dns';
import { classifyAddress } from './ipClass.js';
import { config } from '../config.js';

/**
 * How much this instance knows about where a peer origin came from.
 *
 * 'approved': the origin was read out of a `federation_peers` row, or it
 *   arrived in the body of an admin-authenticated request. Any address is
 *   allowed: peering across a LAN is a supported deployment shape and the
 *   two-instance test harness peers on loopback.
 * 'asserted': the origin was supplied by someone with no established peering
 *   relationship. A peering-request body, a friend handle a user typed, an
 *   expiry or denial callback to a request that was never accepted. It must
 *   resolve to a publicly routable address, otherwise the party that supplied
 *   it chooses which hosts this instance connects to.
 *
 * The two levels are not circular. A `federation_peers` row is only reachable
 * because the outbound path that created it was itself gated: either an admin
 * typed the origin, or the handshake ran under 'asserted'.
 */
export type OriginTrust = 'approved' | 'asserted';

/**
 * Throw if this origin may not be fetched at the given trust level.
 *
 * Format checks run at both levels: a malformed origin, a non-http scheme, or
 * an origin carrying a path is a bug worth surfacing wherever it comes from.
 * Address classification runs only for 'asserted', and only while
 * FEDERATION_ALLOW_PRIVATE_PEERS is off.
 */
export async function assertPeerOriginAllowed(origin: string, trust: OriginTrust): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Invalid peer origin: ${origin}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid peer origin scheme: ${parsed.protocol}`);
  }

  // An origin is scheme + host + port and nothing more. A value carrying a
  // path, query or fragment is either a bug in whatever wrote it or an attempt
  // to address one specific endpoint, so refuse it before it is joined to a
  // federation path.
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('Invalid peer origin: must carry no path, query or fragment');
  }

  if (trust === 'approved') return;
  if (config.federation.allowPrivatePeers) return;

  // URL.hostname keeps the brackets around an IPv6 literal, and dns.lookup does
  // not accept them.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  let address: string;
  try {
    address = (await dns.promises.lookup(hostname)).address;
  } catch {
    throw new Error(`Peer origin did not resolve: ${parsed.origin}`);
  }

  if (classifyAddress(address) !== 'public') {
    throw new Error(`Peer origin is not reachable on the public internet: ${parsed.origin}`);
  }
}

/**
 * The single outbound path for a request addressed to a peer instance.
 *
 * Redirects are not followed. Every federation endpoint answers directly, so a
 * 3xx from a peer is a misconfiguration or an attempt to move the request
 * elsewhere; callers see the 3xx and handle it through their existing
 * non-2xx branch.
 */
export async function federationFetch(
  origin: string,
  path: string,
  init: RequestInit,
  trust: OriginTrust,
): Promise<Response> {
  await assertPeerOriginAllowed(origin, trust);
  const target = new URL(path, origin).toString();
  return fetch(target, { ...init, redirect: 'manual' });
}
