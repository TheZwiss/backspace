import crypto from 'node:crypto';
import type { FederationRelayEvent } from '@backspace/shared';
import { oneOnOneKey } from '../../src/utils/dmConversation.js';
import { queuedRelayEvents, readDb, withWritableDb, type RelayPostResult } from './federationE2E.js';
import type { TestUser } from './testUsers.js';
import type { SpawnedInstance } from './twoInstanceHarness.js';

/**
 * Fixture helpers for the suites that check a relayed event only acts inside a
 * conversation the sending instance is part of (create, member_add, reactions).
 */

/** POST as a user and return the JSON body; throws on anything but 200/201. */
export async function postAs<T>(inst: SpawnedInstance, token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${inst.origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return await res.json() as T;
}

/** Open a 1-on-1 on `inst` with a user homed on `home`, by their home identity. */
export async function dmWithHomeUser(inst: SpawnedInstance, token: string, user: TestUser, home: SpawnedInstance): Promise<string> {
  return (await postAs<{ id: string }>(inst, token, '/api/dm', { homeUserId: user.id, homeInstance: home.domain })).id;
}

/** Friendship rows, so the real group endpoints' friendship gate passes. */
export function befriend(inst: SpawnedInstance, userId: string, friendIds: string[]): void {
  withWritableDb(inst, db => {
    const insert = db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)');
    for (const friendId of friendIds) insert.run(userId, friendId, Date.now());
  });
}

/** The local row id `inst` holds for a user homed elsewhere. */
export function rowFor(inst: SpawnedInstance, homeUserId: string): string {
  const row = readDb(inst, db =>
    db.prepare('SELECT id FROM users WHERE home_user_id = ?').get(homeUserId) as { id: string } | undefined,
  );
  if (!row) throw new Error(`${inst.domain} holds no row for ${homeUserId}`);
  return row.id;
}

/** The key of the 1-on-1 between two home identities (`oneOnOneKey`). */
export function pairFederatedId(a: string, b: string): string {
  return oneOnOneKey({ id: a, homeUserId: null }, { id: b, homeUserId: null });
}

export function channelByFederatedId(inst: SpawnedInstance, federatedId: string): string | undefined {
  return readDb(inst, db =>
    (db.prepare('SELECT id FROM dm_channels WHERE federated_id = ?').get(federatedId) as { id: string } | undefined)?.id,
  );
}

export function memberIds(inst: SpawnedInstance, channelId: string): string[] {
  return readDb(inst, db =>
    (db.prepare('SELECT user_id AS id FROM dm_members WHERE dm_channel_id = ?').all(channelId) as { id: string }[])
      .map(r => r.id).sort(),
  );
}

/**
 * The events `inst` queued for a conversation, once each. The outbox holds a
 * row per target peer; a receiver gets each event once.
 */
export function queuedOnce(inst: SpawnedInstance, contextId: string, eventType: string): FederationRelayEvent[] {
  const seen = new Set<string>();
  return queuedRelayEvents(inst, contextId, eventType).filter(e => {
    if (seen.has(e.messageId)) return false;
    seen.add(e.messageId);
    return true;
  });
}

/**
 * Create a group on `sender` as `owner` and deliver the member_add events it
 * queued, so the receiver holds its copy the way it would in production.
 * Returns [group id on sender, federatedId].
 */
export async function groupDelivered(
  sender: SpawnedInstance,
  owner: TestUser,
  members: Array<{ id: string; homeUserId?: string; homeInstance?: string }>,
  deliver: (events: FederationRelayEvent[]) => Promise<RelayPostResult>,
): Promise<[string, string]> {
  befriend(sender, owner.id, members.map(m => m.id));
  const group = await postAs<{ id: string; federatedId: string | null }>(sender, owner.token, '/api/dm/group', { users: members });
  if (!group.federatedId) throw new Error('group has no federatedId');
  const adds = queuedOnce(sender, group.id, 'member_add');
  const res = await deliver(adds);
  for (const add of adds) {
    if (!res.body?.accepted.includes(add.messageId)) throw new Error(`member_add not accepted: ${res.raw}`);
  }
  return [group.id, group.federatedId];
}

/** An event a sender really queued, re-aimed under a fresh message id. */
export function reaimed(template: FederationRelayEvent, changes: Partial<FederationRelayEvent>): FederationRelayEvent {
  return { ...template, messageId: `reaimed-${crypto.randomBytes(6).toString('hex')}`, ...changes };
}

/** Put `user`'s proof on file on `home` that they hold an account on `peer`. */
export async function putProofOnFile(home: SpawnedInstance, user: TestUser, peerOrigin: string, peerDomain: string, accountOnPeer: TestUser): Promise<void> {
  const res = await fetch(`${home.origin}/api/users/@me/federation-registry`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({
      updatedAt: Date.now() + 1_000,
      registry: [{
        origin: peerOrigin, label: peerDomain, username: accountOnPeer.username,
        remoteUserId: accountOnPeer.id, status: 'connected', addedAt: Date.now(), lastConnectedAt: Date.now(),
      }],
    }),
  });
  if (!res.ok) throw new Error(`registry PUT failed: ${res.status} ${await res.text()}`);
}
