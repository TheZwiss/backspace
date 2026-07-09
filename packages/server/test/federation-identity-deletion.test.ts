import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { bootTwoInstances, bootHomePlusRemotes, type TwoInstanceHarness, type MultiRemoteHarness, type SpawnedInstance } from './helpers/twoInstanceHarness.js';
import { peerInstances } from './helpers/seedPeer.js';
import type { TestUser } from './helpers/testUsers.js';
import { connectWs } from './helpers/wsListener.js';

// Every test here boots real federated instances and drives S2S over HTTP, and
// several deliberately wait on log matchers (e.g. logMatched(..., 1_000) per
// remote). The 5s default per-test timeout is meant for unit tests and is too
// tight for this — under CI load the multi-remote fan-out tests intermittently
// timed out. Give the whole file a realistic ceiling; a genuine hang still trips
// it well before then. Hooks keep their own explicit timeouts (beforeAll 90s).
vi.setConfig({ testTimeout: 30_000 });

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

  it('#3 soft mode: tombstone shape, messages/reactions retained, 1-on-1 dm membership kept', async () => {
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
    // 1-on-1 DM membership is KEPT (anonymized) so the thread survives as "Deleted User"
    expect(remote.dmMembership(fx.remoteUser.id).map(r => r.dmChannelId)).toEqual([fx.dmChannelId]);
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
    // 1-on-1 DM membership is KEPT (anonymized) so the thread survives as "Deleted User"
    expect(remote.dmMembership(fx.remoteUser.id).map(r => r.dmChannelId)).toEqual([fx.dmChannelId]);
    // 1-on-1 DM with another live participant SURVIVES (other party still member)
    expect(remote.dmChannelExists(fx.dmChannelId)).toBe(true);
    remote.close();
  });

  it('#19 read-only: mutations on a Deleted-User 1-on-1 are rejected 403 recipient_deleted', async () => {
    const fx = await setupFullDeletionFixture('t19');

    // Survivor authors a message BEFORE the deletion so there is a message THEY own
    // to edit/delete — this ensures the read-only guard (not the ownership 403) is
    // what's exercised on the PATCH/DELETE paths, which resolve via msg.dmChannelId.
    const pre = await fetch(`${harness.remote.origin}/api/dm/${fx.dmChannelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.observerOnRemote.token}` },
      body: JSON.stringify({ content: 'before deletion' }),
    });
    expect(pre.status).toBe(201);
    const { id: messageId } = await pre.json() as { id: string };

    // Tombstone the remote (federated) user via soft delete
    const del = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin], mode: 'soft' }),
    });
    expect(del.status).toBe(200);

    // Survivor (observerOnRemote) POST -> 403 recipient_deleted
    const post = await fetch(`${harness.remote.origin}/api/dm/${fx.dmChannelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.observerOnRemote.token}` },
      body: JSON.stringify({ content: 'still there?' }),
    });
    expect(post.status).toBe(403);
    expect((await post.json()).code).toBe('recipient_deleted');

    // PATCH the survivor's own message (resolves channel via msg.dmChannelId) -> 403
    const patch = await fetch(`${harness.remote.origin}/api/dm/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.observerOnRemote.token}` },
      body: JSON.stringify({ content: 'edit' }),
    });
    expect(patch.status).toBe(403);
    expect((await patch.json()).code).toBe('recipient_deleted');

    // DELETE the survivor's own message (resolves channel via msg.dmChannelId) -> 403
    const remove = await fetch(`${harness.remote.origin}/api/dm/messages/${messageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fx.observerOnRemote.token}` },
    });
    expect(remove.status).toBe(403);
    expect((await remove.json()).code).toBe('recipient_deleted');
  });

  it('#20 read-only: WS reaction_add on a Deleted-User 1-on-1 is silently dropped, not persisted', async () => {
    const fx = await setupFullDeletionFixture('t20');
    const { openInspector } = await import('./helpers/dbInspect.js');

    // Survivor authors a message BEFORE the deletion so there is a message living
    // in the dead thread for the survivor to (attempt to) react on.
    const pre = await fetch(`${harness.remote.origin}/api/dm/${fx.dmChannelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.observerOnRemote.token}` },
      body: JSON.stringify({ content: 'before deletion' }),
    });
    expect(pre.status).toBe(201);
    const { id: messageId } = await pre.json() as { id: string };

    // Tombstone the remote (federated) user via soft delete → thread becomes dead 1-on-1.
    const del = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin], mode: 'soft' }),
    });
    expect(del.status).toBe(200);

    // Sanity: no reaction by the survivor yet.
    const before = openInspector(harness.remote);
    expect(before.dmReactionsForUser(fx.observerOnRemote.id).filter(r => r.dmMessageId === messageId)).toEqual([]);
    before.close();

    // Survivor opens a WS and attempts to react on the message in the dead thread.
    const ws = await connectWs(harness.remote.origin, fx.observerOnRemote.token);
    try {
      ws.send({ type: 'reaction_add', messageId, emoji: '🔥' });
      // The handler is synchronous after the frame arrives; 400ms covers transit +
      // any (rejected) insert attempt. There is no S→C ack for a dropped reaction.
      await new Promise(r => setTimeout(r, 400));
    } finally {
      ws.close();
    }

    // Assert: NO dm_reactions row was persisted for the survivor on that message.
    const after = openInspector(harness.remote);
    expect(after.dmReactionsForUser(fx.observerOnRemote.id).filter(r => r.dmMessageId === messageId)).toEqual([]);
    after.close();
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

  it('#9 unreachable origin: error=unreachable, registry preserved', async () => {
    const { registerLocal } = await import('./helpers/testUsers.js');
    const { seedUnreachablePeer } = await import('./helpers/seedPeer.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const home = await registerLocal(harness.home, 't9');
    const fakeOrigin = await seedUnreachablePeer(harness.home);

    const now = Date.now();
    await fetch(`${harness.home.origin}/api/users/@me/federation-registry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${home.token}` },
      body: JSON.stringify({
        updatedAt: now,
        registry: [{ origin: fakeOrigin, label: 'fake', username: 'x', remoteUserId: '', status: 'connected', addedAt: now }],
      }),
    });

    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${home.token}` },
      body: JSON.stringify({ origins: [fakeOrigin], mode: 'full' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[fakeOrigin].success).toBe(false);
    expect(body.results[fakeOrigin].error).toBe('unreachable');

    const inspect = openInspector(harness.home);
    expect(inspect.registryRow(home.id, fakeOrigin)).toBeTruthy();
    inspect.close();
  });

  it('#10 no active peer: error=no_active_peer', async () => {
    const { registerLocal } = await import('./helpers/testUsers.js');
    const home = await registerLocal(harness.home, 't10');
    const ghostOrigin = 'http://ghost.test.local:9999';
    const now = Date.now();
    await fetch(`${harness.home.origin}/api/users/@me/federation-registry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${home.token}` },
      body: JSON.stringify({
        updatedAt: now,
        registry: [{ origin: ghostOrigin, label: 'ghost', username: 'x', remoteUserId: '', status: 'connected', addedAt: now }],
      }),
    });

    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${home.token}` },
      body: JSON.stringify({ origins: [ghostOrigin], mode: 'full' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[ghostOrigin].error).toBe('no_active_peer');
  });

  it('#13 attribution guard: peer cannot delete users whose homeInstance differs', async () => {
    const { createFederatedUser } = await import('./helpers/testUsers.js');
    const { buildHeadersForOrigin } = await import('./helpers/hmacSign.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const { remoteUser } = await createFederatedUser(harness.home, harness.remote, 't13');

    // Seed an "evil" peer row on the remote with a known secret so HMAC verification
    // passes — we want to test the attribution guard, not HMAC failure.
    // The evil peer claims to be `http://evil.test` but the user's homeInstance is
    // `home.test.local`, so extractDomain('http://evil.test') !== extractDomain(homeInstance)
    // and the attribution guard fires with 403.
    const evilSecret = 'a'.repeat(64);
    const seedRes = await fetch(`${harness.remote.origin}/api/admin/test/seed-peer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'http://evil.test',
        hmacSecret: evilSecret,
        status: 'active',
      }),
    });
    expect(seedRes.ok).toBe(true);

    const body = JSON.stringify({
      homeUserId: remoteUser.homeUserId,
      homeInstance: harness.home.domain,
      mode: 'full',
    });
    const headers = buildHeadersForOrigin(body, evilSecret, 'http://evil.test');

    const res = await fetch(`${harness.remote.origin}/api/federation/identity`, {
      method: 'DELETE',
      headers,
      body,
    });
    expect(res.status).toBe(403);

    const inspect = openInspector(harness.remote);
    expect(inspect.user(remoteUser.id)!.isDeleted).toBe(0);
    inspect.close();
  });

  it('#14 idempotency: DELETE /api/federation/identity is idempotent', async () => {
    const { createFederatedUser } = await import('./helpers/testUsers.js');
    const { buildHeadersForOrigin } = await import('./helpers/hmacSign.js');
    const { remoteUser } = await createFederatedUser(harness.home, harness.remote, 't14');

    const body = JSON.stringify({
      homeUserId: remoteUser.homeUserId,
      homeInstance: harness.home.domain,
      mode: 'full',
    });

    // The receiver looks up the peer row by X-Federation-Origin. peerInstances
    // inserts an identity row keyed by `https://${home.domain}` (the DOMAIN-form),
    // which is what the home's getOurOrigin() returns for inbound auth.
    const claimedOrigin = `https://${harness.home.domain}`;

    // First call — user exists and is live, should succeed
    const r1 = await fetch(`${harness.remote.origin}/api/federation/identity`, {
      method: 'DELETE',
      headers: buildHeadersForOrigin(body, sharedHmacSecret, claimedOrigin),
      body,
    });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1).toEqual({ success: true });

    // Second call — user is already tombstoned; should be idempotent (200 success)
    const r2 = await fetch(`${harness.remote.origin}/api/federation/identity`, {
      method: 'DELETE',
      headers: buildHeadersForOrigin(body, sharedHmacSecret, claimedOrigin),
      body,
    });
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2).toEqual({ success: true });
  });

  it('#16 WS member_left fires for space members on full delete', async () => {
    const { createFederatedUser, registerLocal } = await import('./helpers/testUsers.js');
    const { connectWs } = await import('./helpers/wsListener.js');
    const { homeUser, remoteUser } = await createFederatedUser(harness.home, harness.remote, 't16');
    const observer = await registerLocal(harness.remote, 't16_obs');

    // observer creates space + invite, federated user joins
    const sp = await fetch(`${harness.remote.origin}/api/spaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${observer.token}` },
      body: JSON.stringify({ name: 't16-space' }),
    }).then(r => r.json()) as { id: string };

    const inv = await fetch(`${harness.remote.origin}/api/spaces/${sp.id}/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${observer.token}` },
    }).then(r => r.json()) as { inviteCode: string };

    const joinRes = await fetch(`${harness.remote.origin}/api/spaces/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteUser.token}` },
      body: JSON.stringify({ inviteCode: inv.inviteCode }),
    });
    expect(joinRes.ok).toBe(true);

    // Connect observer's WS to the REMOTE (where the deletion broadcast originates),
    // wait for ready, then trigger the delete from home.
    const ws = await connectWs(harness.remote.origin, observer.token);
    try {
      // Fire the delete and the WS wait simultaneously — production may emit
      // member_left before the home endpoint's response returns.
      const deletePromise = fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
        body: JSON.stringify({ origins: [harness.remote.origin], mode: 'full' }),
      });

      const memberLeftEvent = await ws.waitForEvent('member_left', 5_000);
      // Verified payload shape: flat { type, spaceId, userId } (federation.ts:2127-2131)
      expect(memberLeftEvent).toMatchObject({
        type: 'member_left',
        spaceId: sp.id,
        userId: remoteUser.id,
      });

      const deleteRes = await deletePromise;
      expect(deleteRes.status).toBe(200);
      const body = await deleteRes.json();
      expect(body.results[harness.remote.origin].success).toBe(true);
    } finally {
      ws.close();
    }
  });

  it('#17 mixed result fan-out: success + unreachable in same response', async () => {
    const { createFederatedUser } = await import('./helpers/testUsers.js');
    const { seedUnreachablePeer } = await import('./helpers/seedPeer.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const { homeUser, remoteUser } = await createFederatedUser(harness.home, harness.remote, 't17');

    const fakeOrigin = await seedUnreachablePeer(harness.home);

    // Read the current registry, then PUT a merged registry with both real-remote
    // and fake entries. The LWW guard requires updatedAt > stored, so use Date.now() + 1
    // (createFederatedUser already wrote a timestamp).
    const existing = await fetch(`${harness.home.origin}/api/users/@me/federation-registry`, {
      headers: { Authorization: `Bearer ${homeUser.token}` },
    }).then(r => r.json()) as { registry?: unknown[] };

    const now = Date.now() + 1;
    const putRes = await fetch(`${harness.home.origin}/api/users/@me/federation-registry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({
        updatedAt: now,
        registry: [
          ...(existing.registry ?? []),
          { origin: fakeOrigin, label: 'unreachable', username: 'x', remoteUserId: '', status: 'connected', addedAt: now },
        ],
      }),
    });
    expect(putRes.ok).toBe(true);

    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin, fakeOrigin], mode: 'soft' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[harness.remote.origin].success).toBe(true);
    expect(body.results[fakeOrigin].success).toBe(false);
    expect(body.results[fakeOrigin].error).toBe('unreachable');

    const inspect = openInspector(harness.home);
    expect(inspect.registryRow(homeUser.id, harness.remote.origin)).toBeUndefined();
    expect(inspect.registryRow(homeUser.id, fakeOrigin)).toBeTruthy();
    inspect.close();

    const remote = openInspector(harness.remote);
    expect(remote.user(remoteUser.id)!.isDeleted).toBe(1);
    remote.close();
  });

  it('#18 deleting one federated user does not affect another on the same remote', async () => {
    const { createFederatedUser } = await import('./helpers/testUsers.js');
    const { openInspector } = await import('./helpers/dbInspect.js');
    const a = await createFederatedUser(harness.home, harness.remote, 't18a');
    const b = await createFederatedUser(harness.home, harness.remote, 't18b');

    const res = await fetch(`${harness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.homeUser.token}` },
      body: JSON.stringify({ origins: [harness.remote.origin], mode: 'full' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[harness.remote.origin].success).toBe(true);

    const remote = openInspector(harness.remote);
    expect(remote.user(a.remoteUser.id)!.isDeleted).toBe(1);
    expect(remote.user(b.remoteUser.id)!.isDeleted).toBe(0);
    expect(remote.user(b.remoteUser.id)!.username).toBe(b.remoteUser.username);
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
      // 1-on-1 DM membership is KEPT (anonymized) so the thread survives as "Deleted User"
      expect(ins.dmMembership(fixtures[i].remoteUser.id).map(r => r.dmChannelId)).toEqual([fixtures[i].dmChannelId]);
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
      // 1-on-1 DM membership is KEPT (anonymized) so the thread survives as "Deleted User"
      expect(ins.dmMembership(fixtures[i].remoteUser.id).map(r => r.dmChannelId)).toEqual([fixtures[i].dmChannelId]);
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

let rateLimitHarness: TwoInstanceHarness;

describe('Federation identity deletion — rate limit', () => {
  beforeAll(async () => {
    const { bootTwoInstancesWithRateLimits } = await import('./helpers/twoInstanceHarness.js');
    rateLimitHarness = await bootTwoInstancesWithRateLimits();
    // No peer setup needed — leave-mode tests skip S2S calls anyway, and
    // the test only exercises the home endpoint's rate-limit hook.
  }, 60_000);

  afterAll(async () => {
    if (rateLimitHarness) await rateLimitHarness.cleanup();
  });

  it('#15 rate limit: 6th call within 15min returns 429', async () => {
    const { registerLocal } = await import('./helpers/testUsers.js');
    const home = await registerLocal(rateLimitHarness.home, 't15');
    const now = Date.now();
    const fakeOrigins = Array.from({ length: 5 }, (_, i) => `http://ratelimit-${i}.test:99`);

    // Seed 5 ephemeral registry entries on home (no peer rows needed — leave skips S2S)
    const regRes = await fetch(`${rateLimitHarness.home.origin}/api/users/@me/federation-registry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${home.token}` },
      body: JSON.stringify({
        updatedAt: now,
        registry: fakeOrigins.map(o => ({
          origin: o,
          label: o,
          username: 'x',
          remoteUserId: '',
          status: 'connected',
          addedAt: now,
        })),
      }),
    });
    expect(regRes.ok).toBe(true);

    // 5 successful leave calls (each targets a different fake origin)
    for (const origin of fakeOrigins) {
      const res = await fetch(`${rateLimitHarness.home.origin}/api/users/@me/federation-identity/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${home.token}` },
        body: JSON.stringify({ origins: [origin], mode: 'leave' }),
      });
      expect(res.status).toBe(200);
    }

    // 6th attempt should be rate-limited
    const res6 = await fetch(`${rateLimitHarness.home.origin}/api/users/@me/federation-identity/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${home.token}` },
      body: JSON.stringify({ origins: ['http://does-not-matter.test'], mode: 'leave' }),
    });
    expect(res6.status).toBe(429);
    expect(res6.headers.get('retry-after')).toBeTruthy();
  });
});
