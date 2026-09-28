import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { connect } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  bootIdentityPeered,
  identityOrigin,
  sendDmMessage,
  readDb,
  withWritableDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { channelByFederatedId, memberIds, pairFederatedId } from './helpers/dmScope.js';
import { registerLocal, createFederatedUser, type TestUser } from './helpers/testUsers.js';
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
 * Topology (IDENTITY profile, so B's inbound relay handling is fully real):
 *   alice — native on A, with a federated account on B
 *   carol — native on A
 *   bob, erin — native on B
 * A's real create events are read from A's outbox and posted, signed, to B.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let alice: TestUser;
let carol: TestUser;
let erin: TestUser;

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  ({ homeUser: alice } = await createFederatedUser(A, B, 'alice'));
  carol = await registerLocal(A, 'carol');
  erin = await registerLocal(B, 'erin');
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
