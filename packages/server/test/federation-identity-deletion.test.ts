import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTwoInstances, bootHomePlusRemotes, type TwoInstanceHarness, type MultiRemoteHarness, type SpawnedInstance } from './helpers/twoInstanceHarness.js';
import { peerInstances } from './helpers/seedPeer.js';
import type { TestUser } from './helpers/testUsers.js';
import { connectWs } from './helpers/wsListener.js';

let harness: TwoInstanceHarness;
let sharedHmacSecret: string;

/**
 * Setup for tests #3 / #5 / #16 / etc.: federated user has a remote space membership,
 * authored 2 messages with reactions, and is in a 1-on-1 DM with another live user.
 * Returns enough handles for tests to assert post-state.
 */
async function setupFullDeletionFixture(label: string): Promise<{
  homeUser: TestUser;
  remoteUser: TestUser;
  observerOnRemote: TestUser;
  spaceId: string;
  channelId: string;
  authoredMessageIds: string[];
  dmChannelId: string;
}> {
  const { registerLocal, createFederatedUser } = await import('./helpers/testUsers.js');
  const { homeUser, remoteUser } = await createFederatedUser(harness.home, harness.remote, label);
  const observerOnRemote = await registerLocal(harness.remote, `${label}_obs`);

  // observerOnRemote creates a space, generates an invite, federated user joins.
  const spaceRes = await fetch(`${harness.remote.origin}/api/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${observerOnRemote.token}` },
    body: JSON.stringify({ name: `${label}-space` }),
  });
  if (!spaceRes.ok) throw new Error(`create space failed: ${spaceRes.status} ${await spaceRes.text()}`);
  const spaceData = await spaceRes.json() as { id: string };
  const spaceId = spaceData.id;

  // Invite endpoint takes no body — Fastify rejects empty body when content-type
  // is application/json, so we omit Content-Type entirely here.
  const inviteRes = await fetch(`${harness.remote.origin}/api/spaces/${spaceId}/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${observerOnRemote.token}` },
  });
  if (!inviteRes.ok) throw new Error(`create invite failed: ${inviteRes.status} ${await inviteRes.text()}`);
  const inviteData = await inviteRes.json() as { inviteCode: string };

  const joinRes = await fetch(`${harness.remote.origin}/api/spaces/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteUser.token}` },
    body: JSON.stringify({ inviteCode: inviteData.inviteCode }),
  });
  if (!joinRes.ok) throw new Error(`join space failed: ${joinRes.status} ${await joinRes.text()}`);

  // Get the space's first channel via GET /api/spaces/:id (must be a member; remote user just joined)
  const spaceDetailsRes = await fetch(`${harness.remote.origin}/api/spaces/${spaceId}`, {
    headers: { Authorization: `Bearer ${remoteUser.token}` },
  });
  if (!spaceDetailsRes.ok) throw new Error(`get space details failed: ${spaceDetailsRes.status} ${await spaceDetailsRes.text()}`);
  const spaceDetails = await spaceDetailsRes.json() as { channels: { id: string }[] };
  if (!spaceDetails.channels?.length) throw new Error('space has no channels — production created none on space create');
  const channelId = spaceDetails.channels[0].id;

  // Federated user authors 2 messages (rate limit is 5/5s, so 2 back-to-back is fine).
  const authoredMessageIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const msgRes = await fetch(`${harness.remote.origin}/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteUser.token}` },
      body: JSON.stringify({ content: `msg-${i}` }),
    });
    if (!msgRes.ok) throw new Error(`create message failed: ${msgRes.status} ${await msgRes.text()}`);
    const msg = await msgRes.json() as { id: string };
    authoredMessageIds.push(msg.id);
  }

  // Reactions are WS-only — open a transient WS, react, close.
  const reactWs = await connectWs(harness.remote.origin, remoteUser.token);
  try {
    for (const messageId of authoredMessageIds) {
      reactWs.send({ type: 'reaction_add', messageId, emoji: '👍' });
    }
    // Wait briefly for reactions to land before snapshotting. The handler is
    // synchronous after the message arrives; 300ms covers WS frame transit + insert.
    await new Promise(r => setTimeout(r, 300));
  } finally {
    reactWs.close();
  }

  // 1-on-1 DM federated <-> observer
  const dmRes = await fetch(`${harness.remote.origin}/api/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteUser.token}` },
    body: JSON.stringify({ userId: observerOnRemote.id }),
  });
  if (!dmRes.ok) throw new Error(`create dm failed: ${dmRes.status} ${await dmRes.text()}`);
  const dmData = await dmRes.json() as { id: string };
  const dmChannelId = dmData.id;

  const dmMsgRes = await fetch(`${harness.remote.origin}/api/dm/${dmChannelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteUser.token}` },
    body: JSON.stringify({ content: 'hello' }),
  });
  if (!dmMsgRes.ok) throw new Error(`create dm message failed: ${dmMsgRes.status} ${await dmMsgRes.text()}`);

  return { homeUser, remoteUser, observerOnRemote, spaceId, channelId, authoredMessageIds, dmChannelId };
}

/**
 * Multi-remote variant of {@link setupFullDeletionFixture}. Given a pre-existing
 * home user, mirrors the federated identity onto a SPECIFIC remote, joins a
 * fresh space there with 2 authored messages + reactions, and a 1-on-1 DM with
 * a local observer. Does NOT touch the home registry — the caller is expected
 * to PUT the registry exactly once with all remote entries combined.
 *
 * Why not reuse `setupFullDeletionFixture`: that helper closes over the
 * single-remote `harness` global and registers a fresh home user every call.
 * The all-remotes fan-out tests need one home user mirrored onto N remotes.
 */
async function mirrorOnRemote(
  home: SpawnedInstance,
  homeUser: TestUser,
  remote: SpawnedInstance,
  label: string,
): Promise<{
  remoteUser: TestUser;
  observerOnRemote: TestUser;
  spaceId: string;
  channelId: string;
  authoredMessageIds: string[];
  dmChannelId: string;
}> {
  const { registerLocal } = await import('./helpers/testUsers.js');

  const federatedUsername = `${homeUser.username}@${home.domain}`;
  const regRes = await fetch(`${remote.origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: federatedUsername,
      password: homeUser.password,
      displayName: homeUser.username,
      homeInstance: home.domain,
      homeUserId: homeUser.id,
    }),
  });
  if (!regRes.ok) throw new Error(`mirror register failed (${remote.origin}): ${regRes.status} ${await regRes.text()}`);
  const data = await regRes.json() as { user: { id: string }; token: string };
  const remoteUser: TestUser = {
    id: data.user.id,
    username: federatedUsername,
    password: homeUser.password,
    token: data.token,
    origin: remote.origin,
    homeUserId: homeUser.id,
    homeInstance: home.domain,
  };

  const observerOnRemote = await registerLocal(remote, `${label}_obs`);

  const spaceRes = await fetch(`${remote.origin}/api/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${observerOnRemote.token}` },
    body: JSON.stringify({ name: `${label}-space` }),
  });
  if (!spaceRes.ok) throw new Error(`create space failed: ${spaceRes.status} ${await spaceRes.text()}`);
  const { id: spaceId } = await spaceRes.json() as { id: string };

  const inviteRes = await fetch(`${remote.origin}/api/spaces/${spaceId}/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${observerOnRemote.token}` },
  });
  if (!inviteRes.ok) throw new Error(`invite failed: ${inviteRes.status} ${await inviteRes.text()}`);
  const { inviteCode } = await inviteRes.json() as { inviteCode: string };

  const joinRes = await fetch(`${remote.origin}/api/spaces/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteUser.token}` },
    body: JSON.stringify({ inviteCode }),
  });
  if (!joinRes.ok) throw new Error(`join failed: ${joinRes.status} ${await joinRes.text()}`);

  const detRes = await fetch(`${remote.origin}/api/spaces/${spaceId}`, {
    headers: { Authorization: `Bearer ${remoteUser.token}` },
  });
  if (!detRes.ok) throw new Error(`get space details failed: ${detRes.status} ${await detRes.text()}`);
  const det = await detRes.json() as { channels: { id: string }[] };
  if (!det.channels?.length) throw new Error('space has no channels');
  const channelId = det.channels[0].id;

  const authoredMessageIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const msgRes = await fetch(`${remote.origin}/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteUser.token}` },
      body: JSON.stringify({ content: `msg-${i}` }),
    });
    if (!msgRes.ok) throw new Error(`create message failed: ${msgRes.status} ${await msgRes.text()}`);
    const m = await msgRes.json() as { id: string };
    authoredMessageIds.push(m.id);
  }

  const reactWs = await connectWs(remote.origin, remoteUser.token);
  try {
    for (const messageId of authoredMessageIds) {
      reactWs.send({ type: 'reaction_add', messageId, emoji: '👍' });
    }
    await new Promise(r => setTimeout(r, 300));
  } finally {
    reactWs.close();
  }

  const dmRes = await fetch(`${remote.origin}/api/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteUser.token}` },
    body: JSON.stringify({ userId: observerOnRemote.id }),
  });
  if (!dmRes.ok) throw new Error(`create dm failed: ${dmRes.status} ${await dmRes.text()}`);
  const { id: dmChannelId } = await dmRes.json() as { id: string };

  const dmMsgRes = await fetch(`${remote.origin}/api/dm/${dmChannelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteUser.token}` },
    body: JSON.stringify({ content: 'hello' }),
  });
  if (!dmMsgRes.ok) throw new Error(`create dm message failed: ${dmMsgRes.status} ${await dmMsgRes.text()}`);

  return { remoteUser, observerOnRemote, spaceId, channelId, authoredMessageIds, dmChannelId };
}

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

  it('#3 soft mode: tombstone shape, messages/reactions retained, dm membership cleared', async () => {
    const fx = await setupFullDeletionFixture('t3');
    const { openInspector } = await import('./helpers/dbInspect.js');

    // Precondition: the helper actually built the prerequisite state.
    const pre = openInspector(harness.remote);
    expect(pre.spaceMembersForUser(fx.remoteUser.id).map(r => r.spaceId)).toContain(fx.spaceId);
    expect(pre.messagesAuthored(fx.remoteUser.id).length).toBe(2);
    expect(pre.reactionsForUser(fx.remoteUser.id).length).toBe(2);
    expect(pre.dmMembership(fx.remoteUser.id).map(r => r.dmChannelId)).toContain(fx.dmChannelId);
    pre.close();

    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin], mode: 'soft' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[harness.remote.origin].success).toBe(true);

    const remote = openInspector(harness.remote);
    const after = remote.user(fx.remoteUser.id);
    expect(after).toBeTruthy();
    expect(after!.isDeleted).toBe(1);
    expect(after!.username).toBe(`!deleted:${fx.remoteUser.id}`);
    expect(after!.passwordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(after!.displayName).toBeNull();
    expect(after!.avatar).toBeNull();
    expect(after!.banner).toBeNull();
    expect(after!.bio).toBeNull();
    expect(after!.customStatus).toBeNull();
    expect(after!.accentColor).toBeNull();
    expect(after!.avatarColor).toBeNull();
    expect(after!.replicatedInstances).toBe('[]');
    expect(after!.status).toBe('offline');
    expect(after!.isAdmin).toBe(0);

    expect(remote.spaceMembersForUser(fx.remoteUser.id)).toEqual([]);
    expect(remote.messagesAuthored(fx.remoteUser.id).length).toBe(2); // RETAINED
    expect(remote.reactionsForUser(fx.remoteUser.id).length).toBe(2); // RETAINED
    expect(remote.dmMembership(fx.remoteUser.id)).toEqual([]); // dm_members always cleared
    expect(remote.dmChannelExists(fx.dmChannelId)).toBe(true); // other party still member
    remote.close();

    const home = openInspector(harness.home);
    expect(home.registryRow(fx.homeUser.id, harness.remote.origin)).toBeUndefined();
    home.close();
  });

  it('#5 full mode: tombstone + reactions/messages purged, 1-on-1 DM with live other party survives', async () => {
    const fx = await setupFullDeletionFixture('t5');
    const { openInspector } = await import('./helpers/dbInspect.js');

    // Precondition: helper built the prerequisite state correctly.
    const pre = openInspector(harness.remote);
    expect(pre.messagesAuthored(fx.remoteUser.id).length).toBe(2);
    expect(pre.reactionsForUser(fx.remoteUser.id).length).toBe(2);
    pre.close();

    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin], mode: 'full' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[harness.remote.origin].success).toBe(true);

    const remote = openInspector(harness.remote);
    const after = remote.user(fx.remoteUser.id);
    expect(after).toBeTruthy();
    expect(after!.isDeleted).toBe(1);
    expect(after!.username).toBe(`!deleted:${fx.remoteUser.id}`);

    expect(remote.messagesAuthored(fx.remoteUser.id).length).toBe(0); // PURGED
    expect(remote.reactionsForUser(fx.remoteUser.id).length).toBe(0); // PURGED
    expect(remote.dmMembership(fx.remoteUser.id)).toEqual([]);
    // 1-on-1 DM with another live participant SURVIVES (other party still member)
    expect(remote.dmChannelExists(fx.dmChannelId)).toBe(true);
    remote.close();
  });

  it('#7 owned-spaces 409: ownership prevents deletion, registry preserved', async () => {
    const { createFederatedUser } = await import('./helpers/testUsers.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const { seedOwnedSpace } = await import('./helpers/seedSpaceWithStubOwner.js');
    const { homeUser, remoteUser } = await createFederatedUser(harness.home, harness.remote, 't7');

    // Direct DB seed: the federated user owns a space on the remote
    const { spaceId } = seedOwnedSpace(harness.remote, remoteUser.id, 't7-space');

    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin], mode: 'full' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[harness.remote.origin].success).toBe(false);
    expect(body.results[harness.remote.origin].error).toBe('owns_spaces');
    expect(body.results[harness.remote.origin].ownedSpaces).toEqual([
      expect.objectContaining({ id: spaceId, name: 't7-space' }),
    ]);

    // Remote user UNCHANGED, home registry UNCHANGED
    const remote = openInspector(harness.remote);
    expect(remote.user(remoteUser.id)!.isDeleted).toBe(0);
    remote.close();
    const home = openInspector(harness.home);
    expect(home.registryRow(homeUser.id, harness.remote.origin)).toBeTruthy();
    home.close();
  });

  it('#8 owned-spaces resolved by transferring ownership, retry succeeds', async () => {
    const { createFederatedUser, registerLocal } = await import('./helpers/testUsers.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const { seedOwnedSpace } = await import('./helpers/seedSpaceWithStubOwner.js');
    const { homeUser, remoteUser } = await createFederatedUser(harness.home, harness.remote, 't8');
    const newOwner = await registerLocal(harness.remote, 't8_newowner');
    const { spaceId } = seedOwnedSpace(harness.remote, remoteUser.id, 't8-space');

    // Transfer ownership via direct DB write — there is no production endpoint
    // for a federated stub to transfer ownership (federated stubs aren't supposed
    // to BE owners in the first place; we only got here via test seeding).
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(harness.remote.dbPath);
    try {
      db.prepare('UPDATE spaces SET owner_id = ? WHERE id = ?').run(newOwner.id, spaceId);
    } finally {
      db.close();
    }

    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin], mode: 'full' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[harness.remote.origin].success).toBe(true);

    const remote = openInspector(harness.remote);
    expect(remote.user(remoteUser.id)!.isDeleted).toBe(1);
    remote.close();
  });

});

let multiHarness: MultiRemoteHarness;

describe('Federation identity deletion — all-remotes fan-out', () => {
  beforeAll(async () => {
    multiHarness = await bootHomePlusRemotes(2);
    await peerInstances(multiHarness.home, multiHarness.remotes[0]);
    await peerInstances(multiHarness.home, multiHarness.remotes[1]);
  }, 90_000);

  afterAll(async () => {
    if (multiHarness) await multiHarness.cleanup();
  });

  it('#2 leave mode all-remotes: both registries cleaned, both remote rows untouched', async () => {
    const { registerLocal } = await import('./helpers/testUsers.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const { logMatched } = await import('./helpers/twoInstanceHarness.js');
    const home = await registerLocal(multiHarness.home, 't2');

    // Create federated identities on BOTH remotes for the same home user.
    // Sequential awaits avoid any race on identical username inserts (the two
    // remotes share neither DB nor port, but sequential is cheap and explicit).
    const remoteUserIds: string[] = [];
    for (const r of multiHarness.remotes) {
      const resR = await fetch(`${r.origin}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: `${home.username}@${multiHarness.home.domain}`,
          password: home.password,
          displayName: home.username,
          homeInstance: multiHarness.home.domain,
          homeUserId: home.id,
        }),
      });
      // /api/auth/register returns 201 Created (verified against auth.ts).
      expect(resR.ok).toBe(true);
      const data = await resR.json() as { user: { id: string }; token: string };
      remoteUserIds.push(data.user.id);
    }

    // Seed home registry with BOTH remotes via a single PUT.
    const now = Date.now();
    const regRes = await fetch(`${multiHarness.home.origin}/api/users/@me/federation-registry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${home.token}` },
      body: JSON.stringify({
        updatedAt: now,
        registry: multiHarness.remotes.map((r, i) => ({
          origin: r.origin,
          label: r.domain,
          username: `${home.username}@${multiHarness.home.domain}`,
          remoteUserId: remoteUserIds[i],
          status: 'connected',
          addedAt: now,
        })),
      }),
    });
    expect(regRes.status).toBe(200);

    // Snapshot remote users pre-delete.
    const beforeRows = multiHarness.remotes.map((r, i) => {
      const ins = openInspector(r);
      const row = ins.user(remoteUserIds[i]);
      ins.close();
      return row;
    });
    for (const before of beforeRows) {
      expect(before).toBeTruthy();
      expect(before!.isDeleted).toBe(0);
    }

    // Fan out leave to BOTH origins.
    const res = await fetch(`${multiHarness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${home.token}` },
      body: JSON.stringify({ origins: multiHarness.remotes.map(r => r.origin), mode: 'leave' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const r of multiHarness.remotes) {
      expect(body.results[r.origin]).toEqual({ success: true });
    }

    // No S2S call should have hit either remote.
    for (const r of multiHarness.remotes) {
      const sawS2S = await logMatched(r, /\/api\/federation\/identity/, 1_000);
      expect(sawS2S).toBe(false);
    }

    // Both remote user rows UNCHANGED.
    multiHarness.remotes.forEach((r, i) => {
      const ins = openInspector(r);
      const after = ins.user(remoteUserIds[i]);
      expect(after).toMatchObject({
        id: beforeRows[i]!.id,
        username: beforeRows[i]!.username,
        isDeleted: 0,
      });
      ins.close();
    });

    // Home registry rows for BOTH origins gone.
    const homeIns = openInspector(multiHarness.home);
    for (const r of multiHarness.remotes) {
      expect(homeIns.registryRow(home.id, r.origin)).toBeUndefined();
    }
    homeIns.close();
  });

  it('#4 soft mode all-remotes: tombstone shape on each remote, messages retained, registries cleaned', async () => {
    const { registerLocal } = await import('./helpers/testUsers.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const homeUser = await registerLocal(multiHarness.home, 't4');

    // Mirror sequentially: parallel mirrors are safe across separate remotes,
    // but sequential keeps the boot log readable and avoids any cross-remote
    // contention on the home user's connection (registry PUT comes later).
    const fixtures: Awaited<ReturnType<typeof mirrorOnRemote>>[] = [];
    for (let i = 0; i < multiHarness.remotes.length; i++) {
      fixtures.push(await mirrorOnRemote(multiHarness.home, homeUser, multiHarness.remotes[i], `t4_${i}`));
    }

    // Single PUT on home registry with both remote entries.
    const now = Date.now();
    const regRes = await fetch(`${multiHarness.home.origin}/api/users/@me/federation-registry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({
        updatedAt: now,
        registry: multiHarness.remotes.map((r, i) => ({
          origin: r.origin,
          label: r.domain,
          username: fixtures[i].remoteUser.username,
          remoteUserId: fixtures[i].remoteUser.id,
          status: 'connected',
          addedAt: now,
        })),
      }),
    });
    expect(regRes.status).toBe(200);

    // Fan out soft delete.
    const res = await fetch(`${multiHarness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({ origins: multiHarness.remotes.map(r => r.origin), mode: 'soft' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const r of multiHarness.remotes) {
      expect(body.results[r.origin].success).toBe(true);
    }

    // Per-remote tombstone + content retention assertions (mirror of #3).
    multiHarness.remotes.forEach((r, i) => {
      const ins = openInspector(r);
      const after = ins.user(fixtures[i].remoteUser.id);
      expect(after).toBeTruthy();
      expect(after!.isDeleted).toBe(1);
      expect(after!.username).toBe(`!deleted:${fixtures[i].remoteUser.id}`);
      expect(after!.passwordHash).toMatch(/^[0-9a-f]{64}$/);
      expect(after!.displayName).toBeNull();
      expect(after!.replicatedInstances).toBe('[]');
      expect(after!.status).toBe('offline');
      expect(after!.isAdmin).toBe(0);

      expect(ins.spaceMembersForUser(fixtures[i].remoteUser.id)).toEqual([]);
      expect(ins.messagesAuthored(fixtures[i].remoteUser.id).length).toBe(2); // RETAINED
      expect(ins.reactionsForUser(fixtures[i].remoteUser.id).length).toBe(2); // RETAINED
      expect(ins.dmMembership(fixtures[i].remoteUser.id)).toEqual([]);
      expect(ins.dmChannelExists(fixtures[i].dmChannelId)).toBe(true);
      ins.close();
    });

    // Home registry rows for BOTH origins gone.
    const home = openInspector(multiHarness.home);
    for (const r of multiHarness.remotes) {
      expect(home.registryRow(homeUser.id, r.origin)).toBeUndefined();
    }
    home.close();
  });

  it('#6 full mode all-remotes: tombstone + purge on each remote, registries cleaned', async () => {
    const { registerLocal } = await import('./helpers/testUsers.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const homeUser = await registerLocal(multiHarness.home, 't6');

    const fixtures: Awaited<ReturnType<typeof mirrorOnRemote>>[] = [];
    for (let i = 0; i < multiHarness.remotes.length; i++) {
      fixtures.push(await mirrorOnRemote(multiHarness.home, homeUser, multiHarness.remotes[i], `t6_${i}`));
    }

    const now = Date.now();
    const regRes = await fetch(`${multiHarness.home.origin}/api/users/@me/federation-registry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({
        updatedAt: now,
        registry: multiHarness.remotes.map((r, i) => ({
          origin: r.origin,
          label: r.domain,
          username: fixtures[i].remoteUser.username,
          remoteUserId: fixtures[i].remoteUser.id,
          status: 'connected',
          addedAt: now,
        })),
      }),
    });
    expect(regRes.status).toBe(200);

    const res = await fetch(`${multiHarness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({ origins: multiHarness.remotes.map(r => r.origin), mode: 'full' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const r of multiHarness.remotes) {
      expect(body.results[r.origin].success).toBe(true);
    }

    // Per-remote tombstone + purge assertions (mirror of #5).
    multiHarness.remotes.forEach((r, i) => {
      const ins = openInspector(r);
      const after = ins.user(fixtures[i].remoteUser.id);
      expect(after).toBeTruthy();
      expect(after!.isDeleted).toBe(1);
      expect(after!.username).toBe(`!deleted:${fixtures[i].remoteUser.id}`);
      expect(ins.messagesAuthored(fixtures[i].remoteUser.id).length).toBe(0); // PURGED
      expect(ins.reactionsForUser(fixtures[i].remoteUser.id).length).toBe(0); // PURGED
      expect(ins.dmMembership(fixtures[i].remoteUser.id)).toEqual([]);
      // Observer remains a member, so DM channel survives.
      expect(ins.dmChannelExists(fixtures[i].dmChannelId)).toBe(true);
      ins.close();
    });

    // Home registry rows for BOTH origins gone.
    const home = openInspector(multiHarness.home);
    for (const r of multiHarness.remotes) {
      expect(home.registryRow(homeUser.id, r.origin)).toBeUndefined();
    }
    home.close();
  });
});
