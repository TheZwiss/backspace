import crypto from 'node:crypto';
import type { SpawnedInstance } from './twoInstanceHarness.js';

/**
 * Install matching federation_peers rows on both instances pointing at each other,
 * with a single shared HMAC secret. Returns the secret for tests that need to sign
 * raw S2S requests directly.
 *
 * Why two rows per direction (transport row + identity row):
 * Production code stores `peer.origin` as a single string and uses it for BOTH
 *   (a) outbound URL: `fetch(${peer.origin}/api/...)` — wants the transport URL, AND
 *   (b) inbound auth: `WHERE origin = X-Federation-Origin` — wants `getOurOrigin()`.
 * In production with `DOMAIN=example.com`, both reduce to `https://example.com`,
 * so a single row satisfies both. In a localhost integration harness the two
 * forms cannot be collapsed:
 *   - The transport URL is `http://127.0.0.1:<ephemeral-port>` (per-instance unique).
 *   - `getOurOrigin()` defaults to `https://${DOMAIN}` (= `https://home.test.local`),
 *     and even with the `PUBLIC_ORIGIN` env override the receiver's attribution
 *     guard `extractDomain(user.homeInstance) === extractDomain(fedHeaders.origin)`
 *     forces `homeInstance` to match the URL's hostname. `extractDomain` strips
 *     the port (`new URL().hostname`), so unique-port localhost instances all
 *     share the hostname `127.0.0.1` and attribution becomes ambiguous in
 *     multi-remote setups. And the `homeInstance` validator regex
 *     (`/^[a-zA-Z0-9._-]+$/` in `auth.ts`) rejects `:` — so we cannot encode
 *     port into `homeInstance` to disambiguate.
 *
 * Therefore the harness keeps `DOMAIN` as a per-instance human label
 * (`home.test.local` / `remoteN.test.local`) for stable identity (federated
 * usernames, attribution domain), and inserts TWO peer rows per direction:
 * one keyed by the transport URL (outbound lookup) and one keyed by the
 * `getOurOrigin()` URL (inbound auth lookup). The schema's UNIQUE(origin)
 * permits both because the strings differ.
 *
 * Eliminating the second row would require a production refactor of either
 * `extractDomain` (port-preserving), the attribution check (decouple from
 * URL), or the `homeInstance` validator (allow `:`). Out of scope here.
 */
export async function peerInstances(
  a: SpawnedInstance,
  b: SpawnedInstance,
): Promise<string> {
  const sharedSecret = crypto.randomBytes(32).toString('hex');

  const seedOn = async (target: SpawnedInstance, peerOrigin: string, peerInstanceName: string) => {
    const res = await fetch(`${target.origin}/api/admin/test/seed-peer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: peerOrigin,
        hmacSecret: sharedSecret,
        status: 'active',
        instanceName: peerInstanceName,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`seed-peer failed on ${target.origin}: ${res.status} ${txt}`);
    }
  };

  // Transport row — outbound URL lookup (`fetch(peer.origin)`).
  await seedOn(a, b.origin, b.domain);
  await seedOn(b, a.origin, a.domain);

  // Identity row — inbound HMAC `X-Federation-Origin` claim, which equals the
  // sender's `getOurOrigin()` (= `https://${DOMAIN}` by default).
  await seedOn(a, `https://${b.domain}`, b.domain);
  await seedOn(b, `https://${a.domain}`, a.domain);

  return sharedSecret;
}

/**
 * Seed an unreachable peer pointing at a guaranteed-unbound port. Returns the origin string.
 * Used by tests #9 and #17 to provoke `error: 'unreachable'` without spawning a real instance.
 */
export async function seedUnreachablePeer(target: SpawnedInstance): Promise<string> {
  const fakeOrigin = 'http://127.0.0.1:1';
  const sharedSecret = crypto.randomBytes(32).toString('hex');
  const res = await fetch(`${target.origin}/api/admin/test/seed-peer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: fakeOrigin,
      hmacSecret: sharedSecret,
      status: 'active',
      instanceName: 'unreachable.test',
    }),
  });
  if (!res.ok) throw new Error(`seedUnreachablePeer failed: ${res.status}`);
  return fakeOrigin;
}
