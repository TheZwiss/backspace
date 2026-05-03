import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTwoInstances, type TwoInstanceHarness } from './helpers/twoInstanceHarness.js';
import { peerInstances } from './helpers/seedPeer.js';

let harness: TwoInstanceHarness;
let sharedHmacSecret: string;

beforeAll(async () => {
  harness = await bootTwoInstances();
  sharedHmacSecret = await peerInstances(harness.home, harness.remote);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe('Federation identity deletion — server suite', () => {
  it('boots the harness and peers the two instances', async () => {
    expect(harness.home.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(harness.remote.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(sharedHmacSecret).toHaveLength(64);
  });

  it('#11 returns 400 for invalid mode', async () => {
    const { createFederatedUser } = await import('./helpers/testUsers.js');
    const { homeUser } = await createFederatedUser(harness.home, harness.remote, 't11');
    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin], mode: 'foo' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/Invalid mode/);
  });

  it('#12 returns 400 for empty origins', async () => {
    const { createFederatedUser } = await import('./helpers/testUsers.js');
    const { homeUser } = await createFederatedUser(harness.home, harness.remote, 't12');
    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({ origins: [], mode: 'full' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/origins/);
  });
});
