import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { connect } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  queuedRelayEvents,
  sendDmMessage,
  readDb,
  waitUntil,
  withWritableDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { channelByFederatedId, memberIds, pairFederatedId, postAs } from './helpers/dmScope.js';
import { registerLocal, createFederatedUser, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsEvent } from './helpers/wsListener.js';
import { spawnInstance, type SpawnedInstance } from './helpers/twoInstanceHarness.js';
import type { DmChannel } from '@backspace/shared';

// Real instances over real HTTP, plus restarts; the 5s unit default is too tight.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ── e2e: one key per 1-on-1, on every path (ADR 0002, steps 2 and 3) ─────────
 *
 * Every 1-on-1 row stores the key of its two members from insertion, relay on
 * or off; rows that predate that (or were made while relay was off) get it
 * from the startup backfill, which also merges such a row into the copy the
 * relay created for the same pair. Local create looks a 1-on-1 up by that key
 * first, so a relay-created copy is returned instead of a second insert that
 * the unique index turns into a 500.
 *
 * Opening a 1-on-1 puts it in the opener's list only (#360): the recipient's
 * membership is created closed, and the first message brings the
 * conversation to them. The relay's copy on the other instance is unchanged:
 * it is created with the message, open for both.
 *
 * Topology (IDENTITY profile, so B's inbound relay handling is fully real):
 *   alice — native on A, with a federated account on B
 *   carol, dave — native on A
 *   bob, erin — native on B
 * A's real create events are read from A's outbox and posted, signed, to B.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let alice: TestUser;
let carol: TestUser;
let bob: TestUser;
let erin: TestUser;
let dave: TestUser;

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  ({ homeUser: alice } = await createFederatedUser(A, B, 'alice'));
  carol = await registerLocal(A, 'carol');
  bob = await registerLocal(B, 'bob');
  erin = await registerLocal(B, 'erin');
  dave = await registerLocal(A, 'dave');
}, 90_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

/** Whether anything still accepts connections on a local port. */
function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Stop an instance and boot it again on the same port, database and secret,
 * so tokens stay valid and peers still reach it. The harness object is
 * updated in place, so the harness cleanup stops the new process.
 */
async function restart(inst: SpawnedInstance): Promise<void> {
  const exited = new Promise<void>(resolve => inst.proc.once('exit', () => resolve()));
  inst.proc.kill('SIGTERM');
  await exited;
  // `pnpm exec` can exit before the server it started has closed its socket;
  // booting again before the port is free would talk to the old process.
  const deadline = Date.now() + 15_000;
  while (await portInUse(inst.port)) {
    if (Date.now() > deadline) throw new Error(`${inst.domain} still listens on ${inst.port} after SIGTERM`);
    await new Promise(r => setTimeout(r, 100));
  }
  const fresh = await spawnInstance({
    domain: inst.domain,
    port: inst.port,
    dbPath: inst.dbPath,
    storagePath: inst.storagePath,
    jwtSecret: inst.jwtSecret,
    logPath: inst.logPath,
  });
  Object.assign(inst, fresh);
}

/**
 * The snapshots in an instance's default backup directory (next to its
 * database; the harness puts every instance's database in one run directory).
 */
function snapshotsOf(inst: SpawnedInstance): string[] {
  const dir = path.join(path.dirname(inst.dbPath), 'backups');
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.db')).sort() : [];
}

function setRelayEnabled(inst: SpawnedInstance, enabled: boolean): void {
  withWritableDb(inst, db => db.prepare('UPDATE instance_settings SET federation_relay_enabled = ? WHERE id = 1').run(enabled ? 1 : 0));
}

function storedKey(inst: SpawnedInstance, channelId: string): string | null | undefined {
  return readDb(inst, db =>
    (db.prepare('SELECT federated_id AS fid FROM dm_channels WHERE id = ?').get(channelId) as { fid: string | null } | undefined)?.fid,
  );
}

function messageIdsIn(inst: SpawnedInstance, channelId: string): string[] {
  return readDb(inst, db =>
    (db.prepare('SELECT id FROM dm_messages WHERE dm_channel_id = ? ORDER BY created_at').all(channelId) as { id: string }[]).map(r => r.id),
  );
}

async function openDm(inst: SpawnedInstance, token: string, body: Record<string, string>): Promise<{ status: number; dm: DmChannel }> {
  const res = await fetch(`${inst.origin}/api/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, dm: await res.json() as DmChannel };
}

describe('federation e2e: local create looks a 1-on-1 up by its key first', () => {
  it('B answers a local create with the relay-created copy (200) when that copy holds other member rows', async () => {
    const dmOnA = await postAs<DmChannel>(A, alice.token, '/api/dm', { homeUserId: bob.id, homeInstance: B.domain });
    const key = pairFederatedId(alice.id, bob.id);
    expect(dmOnA.federatedId).toBe(key);

    const sent = await sendDmMessage(A, alice.token, dmOnA.id, { content: 'relay creates the copy on B' });
    expect(sent.status).toBe(201);
    const event = queuedRelayEvents(A, dmOnA.id, 'create').find(e => e.messageId === sent.id);
    expect(event).toBeDefined();
    const res = await postSignedRelay(B, identityOrigin(A), peerSecretOn(B, identityOrigin(A)), [event!]);
    expect(res.body?.accepted).toContain(sent.id);

    const copyOnB = channelByFederatedId(B, key);
    expect(copyOnB).toBeDefined();
    const aliceRowOnB = memberIds(B, copyOnB!).find(id => id !== bob.id);
    expect(aliceRowOnB).toBeDefined();

    // B's copy loses alice's member row: a local create by membership no
    // longer finds it, and inserting the pair's key again violates the unique
    // index.
    withWritableDb(B, db => db.prepare('DELETE FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').run(copyOnB, aliceRowOnB));

    const opened = await openDm(B, bob.token, { homeUserId: alice.id, homeInstance: A.domain });
    expect(opened.status).toBe(200);
    expect(opened.dm.id).toBe(copyOnB);
    expect(opened.dm.federatedId).toBe(key);
    expect(memberIds(B, copyOnB!)).toEqual([aliceRowOnB!, bob.id].sort());
    expect(readDb(B, db => (db.prepare('SELECT count(*) AS n FROM dm_channels WHERE federated_id = ?').get(key) as { n: number }).n)).toBe(1);
  });
});

describe('federation e2e: every 1-on-1 holds its key, relay on or off', () => {
  let carolDm: string;
  let erinDm: string;

  it('a 1-on-1 opened while relay is off is keyed at insert', async () => {
    setRelayEnabled(A, false);
    await restart(A);
    // Nothing for the key backfill to change: no snapshot for it.
    expect(snapshotsOf(A)).toEqual([]);

    const withCarol = await openDm(A, alice.token, { userId: carol.id });
    expect(withCarol.status).toBe(201);
    carolDm = withCarol.dm.id;
    expect(withCarol.dm.federatedId).toBe(pairFederatedId(alice.id, carol.id));
    expect(storedKey(A, carolDm)).toBe(pairFederatedId(alice.id, carol.id));

    const withErin = await openDm(A, alice.token, { homeUserId: erin.id, homeInstance: B.domain });
    expect(withErin.status).toBe(201);
    erinDm = withErin.dm.id;
    expect(withErin.dm.federatedId).toBe(pairFederatedId(alice.id, erin.id));
    expect(storedKey(A, erinDm)).toBe(pairFederatedId(alice.id, erin.id));
  });

  it('after a restart an unkeyed 1-on-1 has its key, merged into the copy the relay created for the pair', async () => {
    const key = pairFederatedId(alice.id, erin.id);
    const first = await sendDmMessage(A, alice.token, erinDm, { content: 'written while relay was off' });
    expect(first.status).toBe(201);
    const erinRowOnA = memberIds(A, erinDm).find(id => id !== alice.id)!;

    // The state an instance was left in before every 1-on-1 was keyed at
    // insert: the relay-off row without a key, and the copy a later relayed
    // message created under the key, holding erin's reply.
    const relayCopy = '900000000000000001';
    const reply = '900000000000000002';
    withWritableDb(A, db => {
      db.prepare('UPDATE dm_channels SET federated_id = NULL WHERE id IN (?, ?)').run(erinDm, carolDm);
      db.prepare('INSERT INTO dm_channels (id, owner_id, federated_id, created_at) VALUES (?, NULL, ?, ?)').run(relayCopy, key, Date.now());
      db.prepare('INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?, ?, 0), (?, ?, 0)').run(relayCopy, alice.id, relayCopy, erinRowOnA);
      db.prepare(`INSERT INTO dm_messages (id, dm_channel_id, user_id, content, type, source_instance, source_message_id, created_at)
                  VALUES (?, ?, ?, 'reply from erin', 'user', ?, ?, ?)`).run(reply, relayCopy, erinRowOnA, identityOrigin(B), 'erin-msg-1', Date.now() + 1);
    });
    setRelayEnabled(A, true);
    const snapshotsBefore = snapshotsOf(A);
    await restart(A);
    // The backfill is about to merge and re-key: the database is snapshotted first.
    const taken = snapshotsOf(A).filter(f => !snapshotsBefore.includes(f));
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatch(/-pre-migration\.db$/);

    expect(storedKey(A, carolDm)).toBe(pairFederatedId(alice.id, carol.id));
    expect(storedKey(A, erinDm)).toBeUndefined();
    expect(channelByFederatedId(A, key)).toBe(relayCopy);
    expect(messageIdsIn(A, relayCopy)).toEqual([first.id, reply]);
    expect(memberIds(A, relayCopy)).toEqual([alice.id, erinRowOnA].sort());

    const listRes = await fetch(`${A.origin}/api/dm`, { headers: { Authorization: `Bearer ${alice.token}` } });
    const listed = await listRes.json() as DmChannel[];
    expect(listed.filter(d => d.federatedId === key).map(d => d.id)).toEqual([relayCopy]);
  });
});

function closedFlag(inst: SpawnedInstance, channelId: string, userId: string): number | undefined {
  return readDb(inst, db =>
    (db.prepare('SELECT closed FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(channelId, userId) as { closed: number } | undefined)?.closed,
  );
}

describe('federation e2e: a 1-on-1 reaches its recipient with the first message (#360)', () => {
  it('a local recipient sees nothing until the first message, then gets the conversation with it', async () => {
    const daveWs = await connectWs(A.origin, dave.token);
    try {
      const opened = await openDm(A, alice.token, { userId: dave.id });
      expect(opened.status).toBe(201);
      expect(closedFlag(A, opened.dm.id, dave.id)).toBe(1);

      const listBefore = await fetch(`${A.origin}/api/dm`, { headers: { Authorization: `Bearer ${dave.token}` } });
      expect((await listBefore.json() as DmChannel[]).some(d => d.id === opened.dm.id)).toBe(false);
      expect(daveWs.events.some(e => e.type === 'dm_channel_created')).toBe(false);

      const sent = await sendDmMessage(A, alice.token, opened.dm.id, { content: 'hello dave' });
      expect(sent.status).toBe(201);
      expect(await waitUntil(() => daveWs.events.some(e => e.type === 'dm_message_created'), 8_000)).toBe(true);
      const created = daveWs.events.filter((e: WsEvent) => e.type === 'dm_channel_created');
      expect(created).toHaveLength(1);
      const dm = created[0]!.dmChannel as DmChannel;
      expect(dm.id).toBe(opened.dm.id);
      expect(dm.lastMessage?.id).toBe(sent.id);
      expect(closedFlag(A, opened.dm.id, dave.id)).toBe(0);
    } finally {
      daveWs.close();
    }
  });

  it('a federated recipient: the local copy holds their row closed until the first message; the relayed copy is open for both', async () => {
    const bobOpened = await openDm(A, carol.token, { homeUserId: bob.id, homeInstance: B.domain });
    expect(bobOpened.status).toBe(201);
    const bobRowOnA = memberIds(A, bobOpened.dm.id).find(id => id !== carol.id)!;
    expect(closedFlag(A, bobOpened.dm.id, bobRowOnA)).toBe(1);

    const bobWs = await connectWs(B.origin, bob.token);
    try {
      const sent = await sendDmMessage(A, carol.token, bobOpened.dm.id, { content: 'hello bob' });
      expect(sent.status).toBe(201);
      expect(closedFlag(A, bobOpened.dm.id, bobRowOnA)).toBe(0);

      const event = queuedRelayEvents(A, bobOpened.dm.id, 'create').find(e => e.messageId === sent.id);
      expect(event).toBeDefined();
      const res = await postSignedRelay(B, identityOrigin(A), peerSecretOn(B, identityOrigin(A)), [event!]);
      expect(res.body?.accepted).toContain(sent.id);

      const copyOnB = channelByFederatedId(B, pairFederatedId(carol.id, bob.id))!;
      expect(copyOnB).toBeDefined();
      for (const member of memberIds(B, copyOnB)) expect(closedFlag(B, copyOnB, member)).toBe(0);
      expect(await waitUntil(() => bobWs.events.some(e => e.type === 'dm_message_created'), 8_000)).toBe(true);
      // As before: the relay creates the copy with the message, and no
      // dm_channel_created precedes it.
      expect(bobWs.events.some(e => e.type === 'dm_channel_created')).toBe(false);
      const listed = await fetch(`${B.origin}/api/dm`, { headers: { Authorization: `Bearer ${bob.token}` } });
      expect((await listed.json() as DmChannel[]).map(d => d.id)).toContain(copyOnB);
    } finally {
      bobWs.close();
    }
  });
});
