import crypto from 'node:crypto';
import type { SpawnedInstance } from './twoInstanceHarness.js';

/**
 * Install matching federation_peers rows on both instances pointing at each other,
 * with a single shared HMAC secret. Returns the secret for tests that need to sign
 * raw S2S requests directly.
 *
 * IMPORTANT — dual-origin reality in tests:
 * Production code stores `peer.origin` as a single string and uses it for BOTH
 *   (a) outbound URL: `fetch(${peer.origin}/api/...)`, AND
 *   (b) inbound auth: `WHERE origin = X-Federation-Origin` claim from inbound headers.
 * In production with `DOMAIN=example.com`, both reduce to `https://example.com`.
 *
 * In our test harness, the URL is `http://127.0.0.1:<ephemeral>` but `getOurOrigin()`
 * returns `https://${DOMAIN}` (= `https://home.test.local`). These two values are
 * DIFFERENT, so we cannot satisfy both with one `peer.origin` row.
 *
 * Workaround: insert TWO rows per direction — one with the URL form (for outbound
 * lookup on the sender) and one with the DOMAIN-claim form (for inbound auth on
 * the receiver). The schema has a UNIQUE constraint on `origin`, but the two
 * rows have distinct origins so there is no conflict.
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

  // Outbound lookup form (URL) — what users.ts / federation.ts use to find the
  // hmacSecret given a body-supplied or DB-stored origin URL.
  await seedOn(a, b.origin, b.domain);
  await seedOn(b, a.origin, a.domain);

  // Inbound auth form (DOMAIN claim) — what the receiver uses to look up the
  // peer when validating the X-Federation-Origin header from a sender whose
  // `getOurOrigin()` returns `https://${DOMAIN}`.
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
