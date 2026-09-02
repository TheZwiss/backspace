import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  readDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances, real handshake, real HTTP. See federation-identity-deletion.test.ts.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate for `29ae9d91` — public registration cannot claim a federated
 *    stub ───────────────────────────────────────────────────────────────────────
 *
 * `POST /api/auth/register` is public and unauthenticated, and the
 * `homeInstance` / `homeUserId` it receives are caller-supplied with no proof of
 * control. It used to look for a federation-replicated stub matching those
 * values and write the submitted credentials onto that row. The route is now
 * create-only on every path: one username uniqueness check, then a fresh insert,
 * always 201.
 *
 * The stub here is not hand-inserted. It is produced the way stubs actually come
 * into being: instance A relays a real, HMAC-signed DM `create` over HTTP and
 * B's `resolveOrCreateReplicatedUser` materialises the author. IDENTITY profile,
 * so A and B have distinct federated domains and the stub's `home_instance` is a
 * real remote domain rather than a loopback address.
 *
 * ── Non-vacuity ──────────────────────────────────────────────────────────────
 * "The stub row is byte-identical afterwards" is only meaningful if this suite
 * could see it change. The final test is a positive control that mutates the
 * SAME row through the SAME snapshot function — a legitimate `profile_update`
 * relay from its home instance — and asserts the snapshot differs. A snapshot
 * helper that read the wrong row, the wrong DB, or a stale copy would pass every
 * "unchanged" assertion and fail that one.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secret: string;
let bob: TestUser;

/** The A-homed identity whose stub gets created on B by the relay below. */
const STUB_HOME_USER_ID = '900000000000000301';
const STUB_HINT_USERNAME = 'stubtarget';

let stubId: string;

let counter = 0;
const nextId = (): string => `e2e-stub-${Date.now()}-${counter++}`;

/** Full row snapshot of a user, used to assert "byte-identical". */
type UserSnapshot = Record<string, unknown>;

function snapshotUser(inst: SpawnedInstance, id: string): UserSnapshot | undefined {
  return readDb(inst, db =>
    db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserSnapshot | undefined,
  );
}

function relayCreate(messageId: string, content: string): FederationRelayEvent {
  return {
    eventType: 'create',
    contextType: 'dm',
    messageId,
    encryptionVersion: 0,
    timestamp: Date.now(),
    participants: [
      {
        homeUserId: STUB_HOME_USER_ID,
        homeInstance: A.domain,
        profile: { username: STUB_HINT_USERNAME, displayName: 'Stub Target' },
      },
      { homeUserId: bob.id, homeInstance: B.domain, profile: { username: bob.username } },
    ],
    message: {
      userId: STUB_HOME_USER_ID,
      homeUserId: STUB_HOME_USER_ID,
      homeInstance: A.domain,
      content,
      replyToId: null,
      editedAt: null,
      createdAt: Date.now(),
    },
  };
}

interface RegisterResult {
  status: number;
  userId: string | null;
  raw: string;
}

async function register(body: Record<string, unknown>): Promise<RegisterResult> {
  const res = await fetch(`${B.origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let userId: string | null = null;
  try {
    userId = (JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null;
  } catch {
    userId = null;
  }
  return { status: res.status, userId, raw };
}

const password = 'stub-claim-e2e-password-1234';

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  secret = peerSecretOn(B, identityOrigin(A));
  bob = await registerLocal(B, 'stubbob');

  const messageId = nextId();
  const res = await postSignedRelay(B, identityOrigin(A), secret, [
    relayCreate(messageId, `stub-bootstrap-${messageId}`),
  ]);
  if (res.status !== 200 || !res.body?.accepted.includes(messageId)) {
    throw new Error(`stub bootstrap relay failed: ${res.status} ${res.raw}`);
  }

  const stub = readDb(B, db =>
    db
      .prepare('SELECT id FROM users WHERE home_user_id = ? AND home_instance = ?')
      .get(STUB_HOME_USER_ID, A.domain) as { id: string } | undefined,
  );
  if (!stub) throw new Error('relay did not produce a replicated stub on B');
  stubId = stub.id;
}, 90_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — federated registration never claims a replicated stub (29ae9d91)', () => {
  it('setup control: the relay really produced a replication-marked stub on B', () => {
    const stub = snapshotUser(B, stubId);
    expect(stub).toBeDefined();
    expect(stub!.password_hash).toBe('!federation-replicated');
    expect(stub!.home_instance).toBe(A.domain);
    expect(stub!.home_user_id).toBe(STUB_HOME_USER_ID);
  });

  it('a registration carrying the stub\'s exact homeUserId + homeInstance creates a NEW user', async () => {
    const before = snapshotUser(B, stubId);

    const res = await register({
      username: `claimsame_${Date.now()}@${A.domain}`,
      password,
      displayName: 'Claim Same Home',
      homeInstance: A.domain,
      homeUserId: STUB_HOME_USER_ID,
    });

    expect(res.status).toBe(201);
    expect(res.userId).toBeTruthy();
    expect(res.userId).not.toBe(stubId);
    expect(snapshotUser(B, stubId)).toEqual(before);
  });

  it('a registration naming a DIFFERENT home instance with the same homeUserId creates a NEW user', async () => {
    const before = snapshotUser(B, stubId);

    const res = await register({
      username: `claimother_${Date.now()}@other.test.local`,
      password,
      displayName: 'Claim Other Home',
      homeInstance: 'other.test.local',
      homeUserId: STUB_HOME_USER_ID,
    });

    expect(res.status).toBe(201);
    expect(res.userId).toBeTruthy();
    expect(res.userId).not.toBe(stubId);
    expect(snapshotUser(B, stubId)).toEqual(before);
  });

  it('a registration matching only by username hint creates a NEW user', async () => {
    const before = snapshotUser(B, stubId);

    // The stub's username is `stubtarget@home.test.local`. Tier-2 lookup used to
    // match on the base name + domain; registration must not consult it at all.
    const res = await register({
      username: `${STUB_HINT_USERNAME}_hint_${Date.now()}@${A.domain}`,
      password,
      displayName: 'Claim By Hint',
      homeInstance: A.domain,
      homeUserId: '900000000000000399',
    });

    expect(res.status).toBe(201);
    expect(res.userId).toBeTruthy();
    expect(res.userId).not.toBe(stubId);
    expect(snapshotUser(B, stubId)).toEqual(before);
  });

  it('the stub keeps its replication marker and stays unauthenticatable after every attempt', async () => {
    const stub = snapshotUser(B, stubId);
    expect(stub!.password_hash).toBe('!federation-replicated');

    // The credentials submitted above were never written onto the stub, so they
    // cannot be used to log in as it.
    const login = await fetch(`${B.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: stub!.username, password }),
    });
    expect(login.status).not.toBe(200);
  });

  it('POSITIVE CONTROL: a legitimate profile_update relay DOES change the same stub row', async () => {
    // Proves the snapshot helper reads live state from the right row in the
    // right database. Without this, every "unchanged" assertion above could be
    // passing because the helper never observes change at all.
    const before = snapshotUser(B, stubId);
    const messageId = nextId();
    const newDisplayName = `Renamed-${messageId}`;

    const res = await postSignedRelay(B, identityOrigin(A), secret, [
      {
        eventType: 'profile_update',
        contextType: 'profile',
        messageId,
        encryptionVersion: 0,
        timestamp: Date.now(),
        profileUpdate: {
          homeUserId: STUB_HOME_USER_ID,
          homeInstance: A.domain,
          profileUpdatedAt: Date.now(),
          username: STUB_HINT_USERNAME,
          displayName: newDisplayName,
          avatar: null,
          banner: null,
          accentColor: null,
          avatarColor: null,
          bio: 'updated by the home instance',
        },
      },
    ]);

    expect(res.status).toBe(200);
    expect(res.body?.accepted).toContain(messageId);

    const after = snapshotUser(B, stubId);
    expect(after).not.toEqual(before);
    expect(after!.display_name).toBe(newDisplayName);
    // Identity columns are still the stub's own — the row was updated, not replaced.
    expect(after!.id).toBe(stubId);
    expect(after!.password_hash).toBe('!federation-replicated');
  });
});
