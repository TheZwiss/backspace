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

  it('#1 leave mode: home registry cleaned, remote untouched, no S2S request hits the remote', async () => {
    const { createFederatedUser } = await import('./helpers/testUsers.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const { logMatched } = await import('./helpers/twoInstanceHarness.js');
    const { homeUser, remoteUser } = await createFederatedUser(harness.home, harness.remote, 't1');

    // Snapshot remote user pre-delete
    const remoteInspect = openInspector(harness.remote);
    const before = remoteInspect.user(remoteUser.id);
    expect(before).toBeTruthy();
    expect(before!.isDeleted).toBe(0);
    remoteInspect.close();

    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin], mode: 'leave' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[harness.remote.origin]).toEqual({ success: true });

    // CRITICAL: prove no S2S call hit the remote. Fastify access logs include the
    // request path; if `/api/federation/identity` appears at all in remote.log
    // after the call, leave mode incorrectly fired an S2S request.
    const sawS2S = await logMatched(harness.remote, /\/api\/federation\/identity/, 1_000);
    expect(sawS2S).toBe(false);

    // Belt-and-suspenders: remote user row UNCHANGED in every column
    const remoteAfter = openInspector(harness.remote);
    const after = remoteAfter.user(remoteUser.id);
    expect(after).toMatchObject({
      id: before!.id,
      username: before!.username,
      isDeleted: 0,
      displayName: before!.displayName,
    });
    remoteAfter.close();

    // Home registry row gone, replicatedInstances trimmed
    const homeInspect = openInspector(harness.home);
    expect(homeInspect.registryRow(homeUser.id, harness.remote.origin)).toBeUndefined();
    const replInst = homeInspect.replicatedInstancesArray(homeUser.id);
    expect(replInst.find(r => r.origin === harness.remote.origin)).toBeUndefined();
    homeInspect.close();
  });
});
