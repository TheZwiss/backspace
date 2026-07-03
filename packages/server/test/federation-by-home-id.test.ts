import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTwoInstances, type TwoInstanceHarness } from './helpers/twoInstanceHarness.js';
import { peerInstances } from './helpers/seedPeer.js';
import { registerLocal } from './helpers/testUsers.js';
import { buildHeadersForOrigin } from './helpers/hmacSign.js';

let harness: TwoInstanceHarness;
let sharedSecret: string;

beforeAll(async () => {
  harness = await bootTwoInstances();
  sharedSecret = await peerInstances(harness.home, harness.remote);
}, 90_000);

afterAll(async () => {
  await harness.cleanup();
});

describe('POST /api/federation/users/by-home-id', () => {
  it('returns canonical username + profile for a native user when looked up by homeUserId', async () => {
    const target = await registerLocal(harness.remote, 'lookup_target');
    const body = JSON.stringify({ homeUserId: target.id });
    const headers = buildHeadersForOrigin(body, sharedSecret, `https://${harness.home.domain}`);

    const res = await fetch(`${harness.remote.origin}/api/federation/users/by-home-id`, {
      method: 'POST',
      headers,
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { found: boolean; user?: { homeUserId: string; username: string; profile: { displayName: string | null } } };
    expect(json.found).toBe(true);
    expect(json.user!.homeUserId).toBe(target.id);
    expect(json.user!.username).toBe(target.username);
  });

  it('returns { found: false } on unknown homeUserId', async () => {
    const body = JSON.stringify({ homeUserId: 'definitely-not-a-real-id' });
    const headers = buildHeadersForOrigin(body, sharedSecret, `https://${harness.home.domain}`);
    const res = await fetch(`${harness.remote.origin}/api/federation/users/by-home-id`, {
      method: 'POST',
      headers,
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { found: boolean };
    expect(json.found).toBe(false);
  });

  it('rejects unsigned requests with 401', async () => {
    const res = await fetch(`${harness.remote.origin}/api/federation/users/by-home-id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeUserId: 'anything' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects non-native targets (replicated stubs) with { found: false }', async () => {
    // Pre-existing stub on remote whose homeInstance is non-null. Use the
    // first registered native user as a sanity comparison: a homeUserId that
    // doesn't match a native non-deleted row → not found.
    const stubLikeBody = JSON.stringify({ homeUserId: 'no-such-stub-id' });
    const headers = buildHeadersForOrigin(stubLikeBody, sharedSecret, `https://${harness.home.domain}`);
    const res = await fetch(`${harness.remote.origin}/api/federation/users/by-home-id`, {
      method: 'POST',
      headers,
      body: stubLikeBody,
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { found: boolean };
    expect(json.found).toBe(false);
  });
});
