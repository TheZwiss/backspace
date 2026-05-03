import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTwoInstances, type TwoInstanceHarness } from './helpers/twoInstanceHarness.js';
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
});
