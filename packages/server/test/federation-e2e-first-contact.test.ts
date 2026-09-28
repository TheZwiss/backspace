import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  bootTransportPeered,
  readDb,
  waitUntil,
  withWritableDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances, real sockets, real signed S2S lookups.
vi.setConfig({ testTimeout: 45_000 });

/**
 * ── e2e: a remote user named by their home on first contact (#348) ─────────
 *
 * alice (native on A) opens a DM with a user homed on B by naming only the
 * identity pair, as the client does. A asks B over the signed
 * `POST /api/federation/users/by-home-id` and creates or renames its row as
 * `<handle>@<domain>` with the display name B reports.
 *
 * TRANSPORT profile: identity host, transport host and peer key are one host,
 * as on a real deployment. The identity names B the way a stored replica does,
 * by the bare host (`extractDomain` drops the port), while A's peer row for B
 * carries the port, as it does for an instance with a port in DOMAIN or
 * PUBLIC_ORIGIN.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let bIdentity: string;
const STUB_CAROL_ON_A = 'e2e-stub-carol-on-a';
const sockets: WsCapture[] = [];

async function setDisplayName(inst: SpawnedInstance, user: TestUser, displayName: string): Promise<void> {
  const res = await fetch(`${inst.origin}/api/users/@me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new Error(`setDisplayName failed: ${res.status} ${await res.text()}`);
}

async function openDmByIdentity(user: TestUser, homeUserId: string, homeInstance: string): Promise<Response> {
  return fetch(`${A.origin}/api/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({ homeUserId, homeInstance }),
  });
}

function rowOnA(homeUserId: string): { id: string; username: string; displayName: string | null } | undefined {
  return readDb(A, db => db.prepare(
    'SELECT id, username, display_name AS displayName FROM users WHERE home_user_id = ?',
  ).get(homeUserId) as { id: string; username: string; displayName: string | null } | undefined);
}

beforeAll(async () => {
  h = await bootTransportPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  bIdentity = new URL(B.origin).hostname;
  alice = await registerLocal(A, 'alice');
  bob = await registerLocal(B, 'bob');
  carol = await registerLocal(B, 'carol');
  await setDisplayName(B, bob, 'Bob Builder');
  await setDisplayName(B, carol, 'Carol Singer');
}, 120_000);

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await h?.cleanup();
});

describe('first contact through the home lookup', () => {
  it('a DM opened by identity creates the row under the handle and display name the home reports', async () => {
    expect(rowOnA(bob.id)).toBeUndefined();

    const res = await openDmByIdentity(alice, bob.id, bIdentity);
    expect(res.status).toBeLessThan(300);

    expect(rowOnA(bob.id)).toEqual(expect.objectContaining({
      username: `${bob.username}@${bIdentity}`,
      displayName: 'Bob Builder',
    }));
  });

  it('an id-named row is renamed, and a friend watching gets the display name in the same announcement', async () => {
    const now = Date.now();
    withWritableDb(A, db => {
      db.prepare(`INSERT INTO users (id, username, display_name, password_hash, status, is_admin, home_instance, home_user_id, created_at)
        VALUES (?, ?, NULL, '!federation-replicated', 'offline', 0, ?, ?, ?)`)
        .run(STUB_CAROL_ON_A, `${carol.id}@${bIdentity}`, bIdentity, carol.id, now);
      db.prepare('INSERT INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').run(alice.id, STUB_CAROL_ON_A, now);
    });
    const ws = await connectWs(A.origin, alice.token);
    sockets.push(ws);
    await ws.waitForEvent('ready');

    const res = await openDmByIdentity(alice, carol.id, bIdentity);
    expect(res.status).toBeLessThan(300);

    expect(rowOnA(carol.id)).toEqual({
      id: STUB_CAROL_ON_A,
      username: `${carol.username}@${bIdentity}`,
      displayName: 'Carol Singer',
    });
    const announced = await waitUntil(() => ws.events.some(e =>
      e.type === 'user_updated'
      && (e.user as { id?: string } | undefined)?.id === STUB_CAROL_ON_A
      && (e.user as { displayName?: string | null }).displayName === 'Carol Singer'
      && (e.user as { username?: string }).username === `${carol.username}@${bIdentity}`,
    ), 5_000);
    expect(announced).toBe(true);
  });
});
