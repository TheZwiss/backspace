import crypto from 'node:crypto';
import type { SpawnedInstance } from './twoInstanceHarness.js';

/**
 * Install matching federation_peers rows on both instances pointing at each other,
 * with a single shared HMAC secret. Returns the secret for tests that need to sign
 * raw S2S requests directly.
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

  await seedOn(a, b.origin, b.domain);
  await seedOn(b, a.origin, a.domain);

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
