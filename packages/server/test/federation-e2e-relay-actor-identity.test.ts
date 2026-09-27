import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  rejectionReason,
  readDb,
  withWritableDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Two real instances over the real HMAC handshake; see
// federation-e2e-attribution.test.ts for why the unit-test timeout is too tight.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate: a relayed actor is resolved by its federated identity ──────────
 *
 * Every inbound relay handler first asks `attributionRefusal` whether the
 * signing peer may speak for the acting identity, a `homeUserId` +
 * `homeInstance` pair. The handler must then act as the local user that IS
 * that pair. A `homeUserId` alone is only unique within one instance, so
 * resolving it without its `homeInstance` can land on a different person, in
 * particular a native user of the receiver whose own id is that value.
 *
 * Each case below names a native user of the receiver (bob, carol) by id while
 * claiming the signing peer as their home. Attribution passes (the claimed home
 * IS the signing peer), so only the identity resolution decides the outcome:
 * the receiver must refuse the event as `attribution_mismatch` and change
 * nothing. Every refusal is paired with a positive control, the same event for
 * a user actually homed on the peer (or a homeward user with standing), which
 * must be accepted and have its effect, so a refusal cannot come from the
 * handler rejecting everything.
 *
 * Fixture rows written with `withWritableDb` (friendships, a pending request,
 * group DMs) only set up the state a handler acts on; the behaviour under test
 * always runs through the real signed `/api/federation/relay` endpoint.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secret: string;

/** Native on B; alice's DM partner. */
let bob: TestUser;
/** Native on B; used for friendship and group DM fixtures. */
let carol: TestUser;
/** Native on B, WITH a federated account recorded on A: homeward standing. */
let erin: TestUser;
/** Native on B; the target of the create and friend-request cases. */
let dave: TestUser;

/** alice is homed on A; B only knows her as a replicated stub. */
const ALICE_HOME_ID = `9${Date.now()}301`;

/** alice's local stub id on B, once the first relayed create materialised it. */
let aliceOnB: string;
/** The 1-on-1 DM alice <-> bob on B, and alice's message in it (A's id). */
let bobDmOnB: string;
let bobDmFederatedId: string;
const M_BOB = `e2e-actor-msg-bob-${Date.now()}`;
/** alice's message in her DM with erin (A's id). */
const M_ERIN = `e2e-actor-msg-erin-${Date.now()}`;

let counter = 0;
const nextId = (label: string): string => `e2e-actor-${label}-${Date.now()}-${counter++}`;
const snowflakeish = (): string => `8${Date.now()}${crypto.randomInt(100_000, 999_999)}`;

async function relay(events: FederationRelayEvent[]) {
  return postSignedRelay(B, identityOrigin(A), secret, events, { capabilities: ['attribution_unproven'] });
}

async function grantHomewardStanding(user: TestUser): Promise<void> {
  const now = Date.now();
  const res = await fetch(`${B.origin}/api/users/@me/federation-registry`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({
      updatedAt: now,
      registry: [{
        origin: identityOrigin(A),
        label: A.domain,
        username: `${user.username}@${B.domain}`,
        remoteUserId: user.id,
        status: 'connected',
        addedAt: now,
        lastConnectedAt: now,
      }],
    }),
  });
  if (!res.ok) throw new Error(`registry PUT failed: ${res.status} ${await res.text()}`);
}

function createFromAlice(messageId: string, partner: TestUser): FederationRelayEvent {
  return {
    eventType: 'create',
    contextType: 'dm',
    messageId,
    encryptionVersion: 0,
    timestamp: Date.now(),
    participants: [
      { homeUserId: ALICE_HOME_ID, homeInstance: A.domain, profile: { username: 'alice' } },
      { homeUserId: partner.id, homeInstance: B.domain, profile: { username: partner.username } },
    ],
    message: {
      userId: ALICE_HOME_ID,
      homeUserId: ALICE_HOME_ID,
      homeInstance: A.domain,
      content: `actor-identity ${messageId}`,
      replyToId: null,
      editedAt: null,
      createdAt: Date.now(),
    },
  };
}

interface Actor { homeUserId: string; homeInstance: string }

/** alice as A names her. */
const aliceActor = (): Actor => ({ homeUserId: ALICE_HOME_ID, homeInstance: A.domain });
/** A native user of B, named by its id but claimed as homed on the signing peer A. */
const claimedOnA = (user: TestUser): Actor => ({ homeUserId: user.id, homeInstance: A.domain });

function reactionEvent(
  eventType: 'reaction_add' | 'reaction_remove',
  id: string,
  messageId: string,
  actor: Actor,
  emoji: string,
): FederationRelayEvent {
  return {
    eventType,
    contextType: 'dm',
    messageId: id,
    encryptionVersion: 0,
    timestamp: Date.now(),
    reaction: {
      messageId,
      messageHomeInstance: identityOrigin(A),
      userId: actor.homeUserId,
      homeUserId: actor.homeUserId,
      homeInstance: actor.homeInstance,
      emoji,
      createdAt: Date.now(),
    },
  };
}

function reactionUsers(messageSourceId: string, emoji: string): string[] {
  return readDb(B, db =>
    (db.prepare(`
      SELECT r.user_id AS userId FROM dm_reactions r
      JOIN dm_messages m ON m.id = r.dm_message_id
      WHERE m.source_message_id = ? AND r.emoji = ?
    `).all(messageSourceId, emoji) as { userId: string }[]).map(r => r.userId),
  );
}

function localIdOfMessage(sourceMessageId: string): string {
  const row = readDb(B, db =>
    db.prepare('SELECT id FROM dm_messages WHERE source_message_id = ?').get(sourceMessageId) as { id: string } | undefined,
  );
  if (!row) throw new Error(`message ${sourceMessageId} not on B`);
  return row.id;
}

function closedFlag(dmChannelId: string, userId: string): number | null {
  const row = readDb(B, db =>
    db.prepare('SELECT closed FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(dmChannelId, userId) as
      { closed: number } | undefined,
  );
  return row ? row.closed : null;
}

function areFriends(a: string, b: string): boolean {
  return readDb(B, db =>
    (db.prepare('SELECT COUNT(*) AS n FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)')
      .get(a, b, b, a) as { n: number }).n > 0,
  );
}

function pendingRequestExists(fromId: string, toId: string): boolean {
  return readDb(B, db =>
    (db.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'")
      .get(fromId, toId) as { n: number }).n > 0,
  );
}

function befriend(a: string, b: string): void {
  const now = Date.now();
  withWritableDb(B, db => {
    const insert = db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)');
    insert.run(a, b, now);
    insert.run(b, a, now);
  });
}

function seedPendingRequest(fromId: string, toId: string): void {
  withWritableDb(B, db => {
    db.prepare("INSERT INTO friend_requests (id, from_id, to_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run(snowflakeish(), fromId, toId, Date.now());
  });
}

/** A group DM on B owned by alice (homed on A), with the given local members. */
function seedGroupDm(memberIds: string[]): { id: string; federatedId: string } {
  const id = snowflakeish();
  const federatedId = `e2e-actor-group-${id}`;
  withWritableDb(B, db => {
    db.prepare(`
      INSERT INTO dm_channels (id, owner_id, federated_id, owner_home_user_id, owner_home_instance, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, aliceOnB, federatedId, ALICE_HOME_ID, identityOrigin(A), Date.now());
    const member = db.prepare('INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?, ?, 0)');
    for (const userId of memberIds) member.run(id, userId);
  });
  return { id, federatedId };
}

/**
 * Rows homed on another instance that carry `homeUserId`. A native user's own
 * row is not counted (it can carry its own id once a relay has named it).
 */
function stubsCarrying(homeUserId: string): number {
  return readDb(B, db =>
    (db.prepare('SELECT COUNT(*) AS n FROM users WHERE home_user_id = ? AND home_instance IS NOT NULL').get(homeUserId) as { n: number }).n,
  );
}

function isGroupMember(dmChannelId: string, userId: string): boolean {
  return closedFlag(dmChannelId, userId) !== null;
}

function systemMessageAuthor(sourceMessageId: string): string | null {
  const row = readDb(B, db =>
    db.prepare("SELECT user_id AS userId FROM dm_messages WHERE source_message_id = ? AND type = 'system'").get(sourceMessageId) as
      { userId: string } | undefined,
  );
  return row?.userId ?? null;
}

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  secret = peerSecretOn(B, identityOrigin(A));

  bob = await registerLocal(B, 'bob');
  carol = await registerLocal(B, 'carol');
  erin = await registerLocal(B, 'erin');
  dave = await registerLocal(B, 'dave');
  await grantHomewardStanding(erin);

  const setup = await relay([createFromAlice(M_BOB, bob), createFromAlice(M_ERIN, erin)]);
  if (setup.status !== 200 || setup.body?.accepted.length !== 2) {
    throw new Error(`setup creates were not accepted: ${setup.status} ${setup.raw}`);
  }
  const stub = readDb(B, db =>
    db.prepare('SELECT id FROM users WHERE home_user_id = ?').get(ALICE_HOME_ID) as { id: string } | undefined,
  );
  if (!stub) throw new Error('alice stub was not created on B');
  aliceOnB = stub.id;
  const dm = readDb(B, db =>
    db.prepare(`
      SELECT c.id, c.federated_id AS federatedId FROM dm_channels c
      JOIN dm_messages m ON m.dm_channel_id = c.id
      WHERE m.source_message_id = ?
    `).get(M_BOB) as { id: string; federatedId: string } | undefined,
  );
  if (!dm) throw new Error('alice <-> bob DM was not created on B');
  bobDmOnB = dm.id;
  bobDmFederatedId = dm.federatedId;
}, 90_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e: a relayed actor is resolved by homeUserId + homeInstance', () => {
  describe('reaction_add', () => {
    it('stores a reaction from a user homed on the sending peer as that user', async () => {
      const id = nextId('react-alice');
      const res = await relay([reactionEvent('reaction_add', id, M_BOB, aliceActor(), '🌿')]);
      expect(res.status).toBe(200);
      expect(res.body?.accepted).toContain(id);
      expect(reactionUsers(M_BOB, '🌿')).toEqual([aliceOnB]);
    });

    it('stores a homeward reaction from a local user with an account on the peer as that local user', async () => {
      const id = nextId('react-erin');
      const res = await relay([reactionEvent('reaction_add', id, M_ERIN, { homeUserId: erin.id, homeInstance: B.domain }, '🌙')]);
      expect(res.status).toBe(200);
      expect(res.body?.accepted).toContain(id);
      expect(reactionUsers(M_ERIN, '🌙')).toEqual([erin.id]);
    });

    it('refuses a reaction whose reactor is not a user of the sending peer', async () => {
      const id = nextId('react-bob');
      const res = await relay([reactionEvent('reaction_add', id, M_BOB, claimedOnA(bob), '🔥')]);
      expect(res.status).toBe(200);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(reactionUsers(M_BOB, '🔥')).toEqual([]);
    });
  });

  describe('reaction_remove', () => {
    it('removes a reaction of a user homed on the sending peer', async () => {
      const addId = nextId('unreact-alice-add');
      await relay([reactionEvent('reaction_add', addId, M_BOB, aliceActor(), '🍂')]);
      expect(reactionUsers(M_BOB, '🍂')).toEqual([aliceOnB]);

      const id = nextId('unreact-alice');
      const res = await relay([reactionEvent('reaction_remove', id, M_BOB, aliceActor(), '🍂')]);
      expect(res.body?.accepted).toContain(id);
      expect(reactionUsers(M_BOB, '🍂')).toEqual([]);
    });

    it('refuses a removal whose reactor is not a user of the sending peer and keeps the local reaction', async () => {
      withWritableDb(B, db => {
        db.prepare('INSERT INTO dm_reactions (id, dm_message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(snowflakeish(), localIdOfMessage(M_BOB), bob.id, '⭐', Date.now());
      });
      const id = nextId('unreact-bob');
      const res = await relay([reactionEvent('reaction_remove', id, M_BOB, claimedOnA(bob), '⭐')]);
      expect(res.status).toBe(200);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(reactionUsers(M_BOB, '⭐')).toEqual([bob.id]);
    });
  });

  describe('dm_typing_start / dm_typing_stop', () => {
    it.each(['dm_typing_start', 'dm_typing_stop'] as const)(
      '%s: accepts a user of the sending peer and refuses a user who is not one',
      async (eventType) => {
        const build = (id: string, actor: Actor): FederationRelayEvent => ({
          eventType,
          contextType: 'dm',
          messageId: id,
          encryptionVersion: 0,
          timestamp: Date.now(),
          federatedId: bobDmFederatedId,
          typing: { ...actor, username: 'someone' },
        });
        const okId = nextId(`${eventType}-alice`);
        const ok = await relay([build(okId, aliceActor())]);
        expect(ok.body?.accepted).toContain(okId);

        const badId = nextId(`${eventType}-bob`);
        const bad = await relay([build(badId, claimedOnA(bob))]);
        expect(bad.body?.accepted).toEqual([]);
        expect(rejectionReason(bad, badId)).toBe('attribution_mismatch');
      },
    );
  });

  describe('read_state_update', () => {
    const build = (id: string, actor: Actor): FederationRelayEvent => ({
      eventType: 'read_state_update',
      contextType: 'dm',
      messageId: id,
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: bobDmFederatedId,
      readState: {
        user: actor,
        messageRef: { sourceInstance: identityOrigin(A), sourceMessageId: M_BOB },
      },
    });
    const readStateOf = (userId: string): string | null => readDb(B, db =>
      (db.prepare('SELECT last_read_message_id AS m FROM read_states WHERE user_id = ? AND channel_id = ?')
        .get(userId, bobDmOnB) as { m: string } | undefined)?.m ?? null,
    );

    it('records the read position of a user homed on the sending peer', async () => {
      const id = nextId('read-alice');
      const res = await relay([build(id, aliceActor())]);
      expect(res.body?.accepted).toContain(id);
      expect(readStateOf(aliceOnB)).toBe(localIdOfMessage(M_BOB));
    });

    it('refuses a read position for a user who is not one of the sending peer', async () => {
      const id = nextId('read-bob');
      const res = await relay([build(id, claimedOnA(bob))]);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(readStateOf(bob.id)).toBeNull();
    });
  });

  describe('dm_close / dm_reopen', () => {
    const build = (eventType: 'dm_close' | 'dm_reopen', id: string, actor: Actor): FederationRelayEvent => ({
      eventType,
      contextType: 'dm',
      messageId: id,
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: bobDmFederatedId,
      dmCloseReopen: actor,
    });

    it('closes and reopens the DM for a user homed on the sending peer', async () => {
      const closeId = nextId('close-alice');
      const closed = await relay([build('dm_close', closeId, aliceActor())]);
      expect(closed.body?.accepted).toContain(closeId);
      expect(closedFlag(bobDmOnB, aliceOnB)).toBe(1);

      const reopenId = nextId('reopen-alice');
      const reopened = await relay([build('dm_reopen', reopenId, aliceActor())]);
      expect(reopened.body?.accepted).toContain(reopenId);
      expect(closedFlag(bobDmOnB, aliceOnB)).toBe(0);
    });

    it('refuses to close the DM for a user who is not one of the sending peer', async () => {
      const id = nextId('close-bob');
      const res = await relay([build('dm_close', id, claimedOnA(bob))]);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(closedFlag(bobDmOnB, bob.id)).toBe(0);
    });

    it('refuses to reopen the DM for a user who is not one of the sending peer', async () => {
      withWritableDb(B, db => {
        db.prepare('UPDATE dm_members SET closed = 1 WHERE dm_channel_id = ? AND user_id = ?').run(bobDmOnB, bob.id);
      });
      const id = nextId('reopen-bob');
      const res = await relay([build('dm_reopen', id, claimedOnA(bob))]);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(closedFlag(bobDmOnB, bob.id)).toBe(1);
    });
  });

  describe('friend_remove', () => {
    const build = (id: string, from: Actor, to: Actor): FederationRelayEvent => ({
      eventType: 'friend_remove',
      contextType: 'friend',
      messageId: id,
      encryptionVersion: 0,
      timestamp: Date.now(),
      friendship: { from, to, createdAt: Date.now() },
    });

    it('ends a friendship of a user homed on the sending peer', async () => {
      befriend(aliceOnB, carol.id);
      const id = nextId('unfriend-alice');
      const res = await relay([build(id, aliceActor(), { homeUserId: carol.id, homeInstance: B.domain })]);
      expect(res.body?.accepted).toContain(id);
      expect(areFriends(aliceOnB, carol.id)).toBe(false);
    });

    it('refuses to end a friendship for a user who is not one of the sending peer', async () => {
      befriend(bob.id, carol.id);
      const id = nextId('unfriend-bob');
      // Neither side is one the peer may speak for: bob's id is not A's to use,
      // and carol has no account on A. Sent without the retry capability, so
      // the refusal is the terminal one.
      const res = await postSignedRelay(B, identityOrigin(A), secret, [
        build(id, claimedOnA(bob), { homeUserId: carol.id, homeInstance: B.domain }),
      ]);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(areFriends(bob.id, carol.id)).toBe(true);
    });
  });

  describe('friend_request_cancel', () => {
    const build = (id: string, from: Actor, to: Actor): FederationRelayEvent => ({
      eventType: 'friend_request_cancel',
      contextType: 'friend',
      messageId: id,
      encryptionVersion: 0,
      timestamp: Date.now(),
      friendship: { from, to, createdAt: Date.now() },
    });

    it('cancels a pending request sent by a user homed on the sending peer', async () => {
      seedPendingRequest(aliceOnB, carol.id);
      const id = nextId('cancel-alice');
      const res = await relay([build(id, aliceActor(), { homeUserId: carol.id, homeInstance: B.domain })]);
      expect(res.body?.accepted).toContain(id);
      expect(pendingRequestExists(aliceOnB, carol.id)).toBe(false);
    });

    it('refuses to cancel a request for a sender who is not a user of the sending peer', async () => {
      seedPendingRequest(bob.id, carol.id);
      const id = nextId('cancel-bob');
      const res = await relay([build(id, claimedOnA(bob), { homeUserId: carol.id, homeInstance: B.domain })]);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(pendingRequestExists(bob.id, carol.id)).toBe(true);
    });
  });

  describe('member_remove (leave)', () => {
    const build = (id: string, federatedId: string, user: Actor): FederationRelayEvent => ({
      eventType: 'member_remove',
      contextType: 'dm',
      messageId: id,
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId,
      membership: { user, reason: 'leave' },
    });

    it('removes a user homed on the sending peer who leaves', async () => {
      const group = seedGroupDm([aliceOnB, bob.id, carol.id]);
      const id = nextId('leave-alice');
      const res = await relay([build(id, group.federatedId, aliceActor())]);
      expect(res.body?.accepted).toContain(id);
      expect(isGroupMember(group.id, aliceOnB)).toBe(false);
      expect(isGroupMember(group.id, bob.id)).toBe(true);
    });

    it('refuses a leave for a user who is not one of the sending peer', async () => {
      const group = seedGroupDm([aliceOnB, bob.id, carol.id]);
      const id = nextId('leave-bob');
      const res = await relay([build(id, group.federatedId, claimedOnA(bob))]);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(isGroupMember(group.id, bob.id)).toBe(true);
      expect(systemMessageAuthor(id)).toBeNull();
    });
  });

  describe('ownership_transfer', () => {
    const build = (id: string, federatedId: string, previousOwner: Actor, newOwner: Actor): FederationRelayEvent => ({
      eventType: 'ownership_transfer',
      contextType: 'dm',
      messageId: id,
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId,
      ownership: { previousOwner, newOwner },
    });
    const ownerOf = (dmChannelId: string): string | null => readDb(B, db =>
      (db.prepare('SELECT owner_id AS ownerId FROM dm_channels WHERE id = ?').get(dmChannelId) as { ownerId: string | null } | undefined)?.ownerId ?? null,
    );

    it('records a transfer by an owner homed on the sending peer as theirs', async () => {
      const group = seedGroupDm([aliceOnB, bob.id, carol.id]);
      const id = nextId('transfer-alice');
      const res = await relay([build(id, group.federatedId, aliceActor(), { homeUserId: carol.id, homeInstance: B.domain })]);
      expect(res.body?.accepted).toContain(id);
      expect(ownerOf(group.id)).toBe(carol.id);
      expect(systemMessageAuthor(id)).toBe(aliceOnB);
    });

    it('refuses a transfer whose previous owner is not a user of the sending peer', async () => {
      const group = seedGroupDm([aliceOnB, bob.id, carol.id]);
      const id = nextId('transfer-bob');
      const res = await relay([build(id, group.federatedId, claimedOnA(bob), { homeUserId: carol.id, homeInstance: B.domain })]);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(ownerOf(group.id)).toBe(aliceOnB);
      expect(systemMessageAuthor(id)).toBeNull();
    });
  });

  describe('create', () => {
    const build = (messageId: string, author: Actor, authorName: string): FederationRelayEvent => ({
      eventType: 'create',
      contextType: 'dm',
      messageId,
      encryptionVersion: 0,
      timestamp: Date.now(),
      participants: [
        { ...author, profile: { username: authorName } },
        { homeUserId: dave.id, homeInstance: B.domain, profile: { username: dave.username } },
      ],
      message: {
        userId: author.homeUserId,
        ...author,
        content: `actor-identity ${messageId}`,
        replyToId: null,
        editedAt: null,
        createdAt: Date.now(),
      },
    });
    const authorOf = (messageId: string): string | null => readDb(B, db =>
      (db.prepare('SELECT user_id AS userId FROM dm_messages WHERE source_message_id = ?').get(messageId) as
        { userId: string } | undefined)?.userId ?? null,
    );

    it('stores a message from a user homed on the sending peer as that user', async () => {
      const id = nextId('create-alice');
      const res = await relay([build(id, aliceActor(), 'alice')]);
      expect(res.body?.accepted).toContain(id);
      expect(authorOf(id)).toBe(aliceOnB);
    });

    it('refuses a message whose author is not a user of the sending peer, and creates no user for it', async () => {
      const id = nextId('create-bob');
      const res = await relay([build(id, claimedOnA(bob), 'bob')]);
      expect(res.status).toBe(200);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(authorOf(id)).toBeNull();
      expect(stubsCarrying(bob.id)).toBe(0);
    });
  });

  describe('friend_request_create', () => {
    const build = (id: string, from: Actor): FederationRelayEvent => ({
      eventType: 'friend_request_create',
      contextType: 'friend',
      messageId: id,
      encryptionVersion: 0,
      timestamp: Date.now(),
      friendship: {
        from,
        to: { homeUserId: dave.id, homeInstance: B.domain },
        fromProfile: { username: 'someone' },
        status: 'pending',
        createdAt: Date.now(),
      },
    });

    it('records a request from a user homed on the sending peer as theirs', async () => {
      const id = nextId('request-alice');
      const res = await relay([build(id, aliceActor())]);
      expect(res.body?.accepted).toContain(id);
      expect(pendingRequestExists(aliceOnB, dave.id)).toBe(true);
    });

    it('refuses a request whose sender is not a user of the sending peer', async () => {
      const id = nextId('request-bob');
      const res = await relay([build(id, claimedOnA(bob))]);
      expect(res.status).toBe(200);
      expect(res.body?.accepted).toEqual([]);
      expect(rejectionReason(res, id)).toBe('attribution_mismatch');
      expect(pendingRequestExists(bob.id, dave.id)).toBe(false);
    });
  });
});

/**
 * The client routes that take a `homeUserId` + `homeInstance` pair resolve it
 * through the same identity lookup. A client names a user native to this
 * instance with this instance's own domain (the `homeInstance` its row has on
 * any other instance), bare or as a URL; that must still reach the native user.
 * The same id named as homed on another instance is a different identity and
 * must not.
 */
describe('client routes: a homeUserId + homeInstance pair reaches the user it names', () => {
  async function call(method: string, pathname: string, token: string, body?: unknown): Promise<Response> {
    return fetch(`${B.origin}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const membersOf = (dmChannelId: string): string[] => readDb(B, db =>
    (db.prepare('SELECT user_id AS userId FROM dm_members WHERE dm_channel_id = ?').all(dmChannelId) as { userId: string }[])
      .map(r => r.userId).sort(),
  );

  it('POST /api/dm reaches a native user named with this instance\'s domain, bare or as a URL', async () => {
    const bare = await call('POST', '/api/dm', carol.token, { homeUserId: bob.id, homeInstance: B.domain });
    expect(bare.ok).toBe(true);
    const dmId = (await bare.json() as { id: string }).id;
    expect(membersOf(dmId)).toEqual([bob.id, carol.id].sort());

    const url = await call('POST', '/api/dm', carol.token, { homeUserId: bob.id, homeInstance: identityOrigin(B) });
    expect(url.ok).toBe(true);
    expect((await url.json() as { id: string }).id).toBe(dmId);
    expect(stubsCarrying(bob.id)).toBe(0);
  });

  it('POST /api/dm does not reach a native user when the id is named as homed on another instance', async () => {
    const res = await call('POST', '/api/dm', carol.token, { homeUserId: bob.id, homeInstance: A.domain });
    expect(res.status).toBe(404);
    expect((await res.json() as { code?: string }).code).toBe('user_not_found');
    expect(stubsCarrying(bob.id)).toBe(0);
  });

  it('group routes: create, add, kick and transfer reach native users named by pair', async () => {
    befriend(carol.id, bob.id);
    befriend(carol.id, dave.id);
    befriend(carol.id, erin.id);

    const created = await call('POST', '/api/dm/group', carol.token, {
      users: [
        { id: bob.id, homeUserId: bob.id, homeInstance: B.domain },
        { id: dave.id, homeUserId: dave.id, homeInstance: identityOrigin(B) },
      ],
    });
    expect(created.status).toBe(201);
    const groupId = (await created.json() as { id: string }).id;
    expect(membersOf(groupId)).toEqual([bob.id, carol.id, dave.id].sort());

    const added = await call('POST', `/api/dm/${groupId}/members`, carol.token, { homeUserId: erin.id, homeInstance: B.domain });
    expect(added.ok).toBe(true);
    expect(membersOf(groupId)).toContain(erin.id);

    const refusedAdd = await call('POST', `/api/dm/${groupId}/members`, carol.token, { homeUserId: erin.id, homeInstance: A.domain });
    expect(refusedAdd.status).toBe(404);

    const kicked = await call('DELETE', `/api/dm/${groupId}/members/${erin.id}?homeInstance=${encodeURIComponent(B.domain)}`, carol.token);
    expect(kicked.ok).toBe(true);
    expect(membersOf(groupId)).not.toContain(erin.id);

    const transferred = await call('POST', `/api/dm/${groupId}/transfer`, carol.token, { homeUserId: bob.id, homeInstance: B.domain });
    expect(transferred.ok).toBe(true);
    expect(readDb(B, db =>
      (db.prepare('SELECT owner_id AS ownerId FROM dm_channels WHERE id = ?').get(groupId) as { ownerId: string }).ownerId,
    )).toBe(bob.id);
    expect(stubsCarrying(bob.id)).toBe(0);
    expect(stubsCarrying(erin.id)).toBe(0);
  });
});
