import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  rejectionReason,
  dmMessageContents,
  stubsFrom,
  readDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Boots two real instances, peers them over the real HMAC handshake and drives
// S2S over HTTP. The 5s unit-test default is far too tight; see
// federation-identity-deletion.test.ts for the original rationale. Hooks keep
// their own explicit timeouts.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate for `10582d87` — relay attribution is resolved from the
 *    authenticated peer ────────────────────────────────────────────────────────
 *
 * The fix has three parts, and all three are only meaningfully testable across
 * two instances that really peered and really speak HMAC-signed HTTP:
 *
 *   1. A relay batch is processed only when its `sourceInstance` equals the peer
 *      whose signature authenticated the request (403 otherwise).
 *   2. `verifyAttribution` takes a `homeUserId` + `homeInstance` PAIR. A peer is
 *      the authority for users homed on it; an actor homed on a THIRD instance
 *      is never accepted.
 *   3. The homeward case — a peer carrying back an event authored by one of OUR
 *      users — is accepted only when that local user actually holds a federated
 *      account on the signing peer.
 *
 * IDENTITY profile (see helpers/federationE2E.ts): each instance has its own
 * federated domain, so `extractDomain` can actually tell A, B and a third
 * instance apart. Peering is the real `/peer/initiate` → `/peer/accept` →
 * signed `/epoch` verification; the HMAC secret every request here is signed
 * with is read back out of the responder's DB, so it is whatever the handshake
 * negotiated.
 *
 * ── Non-vacuity ──────────────────────────────────────────────────────────────
 * Every "rejected" case in this file is paired with a near-identical "accepted"
 * case that differs only in the one field under test, and every rejection
 * asserts the EXACT `reason` string — so a batch that failed for an unrelated
 * structural reason (malformed payload, missing participants, duplicate) cannot
 * masquerade as an attribution refusal. DB side effects are asserted in both
 * directions: the accepted cases prove the pipeline really writes, which is what
 * makes "nothing was written" meaningful in the rejected ones.
 */

const THIRD_INSTANCE = 'third.test.local';

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secret: string;

/** Native on B. Used as the second participant so batches are well-formed. */
let bob: TestUser;
/** Native on B, WITH a federated account recorded on A → homeward standing. */
let erin: TestUser;
/** Native on B, WITHOUT any federated account on A → no homeward standing. */
let frank: TestUser;

let counter = 0;
const nextId = (): string => `e2e-attr-${Date.now()}-${counter++}`;

/**
 * Record that `user` (native on B) holds a federated account on A, via the real
 * `PUT /api/users/@me/federation-registry` endpoint under the user's own
 * session. That row is exactly the evidence `localUserActsOnPeer` consults, and
 * it can only be written by the user themselves — which is the whole point.
 */
async function grantHomewardStanding(user: TestUser): Promise<void> {
  const now = Date.now();
  const res = await fetch(`${B.origin}/api/users/@me/federation-registry`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({
      updatedAt: now,
      registry: [
        {
          origin: identityOrigin(A),
          label: A.domain,
          username: `${user.username}@${B.domain}`,
          remoteUserId: user.id,
          status: 'connected',
          addedAt: now,
          lastConnectedAt: now,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`registry PUT failed: ${res.status} ${await res.text()}`);
}

/** A well-formed 1-on-1 DM `create` event authored by the given identity. */
function createEvent(opts: {
  messageId: string;
  content: string;
  authorHomeUserId: string;
  authorHomeInstance: string;
  authorUsername: string;
}): FederationRelayEvent {
  return {
    eventType: 'create',
    contextType: 'dm',
    messageId: opts.messageId,
    encryptionVersion: 0,
    timestamp: Date.now(),
    participants: [
      {
        homeUserId: opts.authorHomeUserId,
        homeInstance: opts.authorHomeInstance,
        profile: { username: opts.authorUsername },
      },
      {
        homeUserId: bob.id,
        homeInstance: B.domain,
        profile: { username: bob.username },
      },
    ],
    message: {
      userId: opts.authorHomeUserId,
      homeUserId: opts.authorHomeUserId,
      homeInstance: opts.authorHomeInstance,
      content: opts.content,
      replyToId: null,
      editedAt: null,
      createdAt: Date.now(),
    },
  };
}

/** The acting identity an event asserts, in the shape every handler reads. */
interface Actor {
  homeUserId: string;
  homeInstance: string;
  username: string;
}

/** Uniform signature so the handler-coverage table can hold all three builders. */
type EventBuilder = (messageId: string, actor: Actor) => FederationRelayEvent;

const dmCloseEvent: EventBuilder = (messageId, actor) => ({
  eventType: 'dm_close',
  contextType: 'dm',
  messageId,
  encryptionVersion: 0,
  timestamp: Date.now(),
  federatedId: `e2e-attr-fedid-${messageId}`,
  dmCloseReopen: { homeUserId: actor.homeUserId, homeInstance: actor.homeInstance },
});

const typingEvent: EventBuilder = (messageId, actor) => ({
  eventType: 'dm_typing_start',
  contextType: 'dm',
  messageId,
  encryptionVersion: 0,
  timestamp: Date.now(),
  federatedId: `e2e-attr-fedid-${messageId}`,
  typing: actor,
});

const readStateEvent: EventBuilder = (messageId, actor) => ({
  eventType: 'read_state_update',
  contextType: 'dm',
  messageId,
  encryptionVersion: 0,
  timestamp: Date.now(),
  federatedId: `e2e-attr-fedid-${messageId}`,
  readState: {
    user: { homeUserId: actor.homeUserId, homeInstance: actor.homeInstance },
    messageRef: { sourceInstance: identityOrigin(A), sourceMessageId: 'no-such-message' },
  },
});

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  secret = peerSecretOn(B, identityOrigin(A));

  bob = await registerLocal(B, 'bob');
  erin = await registerLocal(B, 'erin');
  frank = await registerLocal(B, 'frank');
  await grantHomewardStanding(erin);
}, 90_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — relay attribution is bound to the authenticated peer (10582d87)', () => {
  it('setup control: the handshake produced a real, active peer row on both sides', () => {
    // If this ever fails, every other assertion in the file is meaningless —
    // a rejected relay would be rejected for want of peering, not attribution.
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const initiatorRow = readDb(A, db =>
      db.prepare('SELECT origin, status FROM federation_peers').all() as { origin: string; status: string }[],
    );
    expect(initiatorRow).toEqual([{ origin: B.origin, status: 'active' }]);
    const responderRow = readDb(B, db =>
      db.prepare('SELECT origin, status FROM federation_peers').all() as { origin: string; status: string }[],
    );
    expect(responderRow).toEqual([{ origin: identityOrigin(A), status: 'active' }]);
  });

  it('accepts a message authored by a user homed on the signing peer', async () => {
    const messageId = nextId();
    const content = `attr-accept-${messageId}`;
    const aliceOnA = '900000000000000101';

    const res = await postSignedRelay(B, identityOrigin(A), secret, [
      createEvent({
        messageId,
        content,
        authorHomeUserId: aliceOnA,
        authorHomeInstance: A.domain,
        authorUsername: 'alice',
      }),
    ]);

    expect(res.status).toBe(200);
    expect(res.body?.accepted).toContain(messageId);
    expect(res.body?.rejected).toEqual([]);
    // The pipeline really wrote: the message landed and the author materialised
    // as a replicated stub homed on A.
    expect(dmMessageContents(B)).toContain(content);
    expect(stubsFrom(B, A.domain).length).toBeGreaterThan(0);
  });

  it('rejects an event whose author is homed on a THIRD instance', async () => {
    const messageId = nextId();
    const content = `attr-third-${messageId}`;
    const before = stubsFrom(B, THIRD_INSTANCE).length;

    const res = await postSignedRelay(B, identityOrigin(A), secret, [
      createEvent({
        messageId,
        content,
        authorHomeUserId: '900000000000000102',
        authorHomeInstance: THIRD_INSTANCE,
        authorUsername: 'mallory',
      }),
    ]);

    // Signature is valid and the batch is well-formed — the ONLY thing wrong is
    // that A is not the identity authority for third.test.local.
    expect(res.status).toBe(200);
    expect(res.body?.accepted).toEqual([]);
    expect(rejectionReason(res, messageId)).toBe('attribution_mismatch');
    expect(dmMessageContents(B)).not.toContain(content);
    // Refused BEFORE participant resolution, so no stub was manufactured either.
    expect(stubsFrom(B, THIRD_INSTANCE).length).toBe(before);
  });

  it('rejects the whole batch when sourceInstance is not the authenticated peer', async () => {
    const messageId = nextId();
    const content = `attr-spoof-${messageId}`;

    // Correctly signed with A's real secret, but claiming to speak AS the third
    // instance. Under the pre-fix code the claimed source was taken at face
    // value, which made the author check tautological.
    const res = await postSignedRelay(
      B,
      identityOrigin(A),
      secret,
      [
        createEvent({
          messageId,
          content,
          authorHomeUserId: '900000000000000103',
          authorHomeInstance: THIRD_INSTANCE,
          authorUsername: 'mallory',
        }),
      ],
      { sourceInstance: `https://${THIRD_INSTANCE}` },
    );

    expect(res.status).toBe(403);
    expect(res.raw).toContain('sourceInstance does not match the authenticated peer');
    expect(dmMessageContents(B)).not.toContain(content);
  });

  it('rejects a batch that claims to originate from the RECEIVER itself', async () => {
    const messageId = nextId();
    const content = `attr-selfsource-${messageId}`;

    const res = await postSignedRelay(
      B,
      identityOrigin(A),
      secret,
      [
        createEvent({
          messageId,
          content,
          authorHomeUserId: bob.id,
          authorHomeInstance: B.domain,
          authorUsername: bob.username,
        }),
      ],
      { sourceInstance: `https://${B.domain}` },
    );

    expect(res.status).toBe(403);
    expect(dmMessageContents(B)).not.toContain(content);
  });

  it('rejects a homeward relay for a local user with no federated account on the peer', async () => {
    const messageId = nextId();
    const content = `attr-homeward-nostanding-${messageId}`;

    // frank is native on B. A claims he authored something. He has never
    // connected to A, so A has no standing to speak for him.
    const res = await postSignedRelay(B, identityOrigin(A), secret, [
      createEvent({
        messageId,
        content,
        authorHomeUserId: frank.id,
        authorHomeInstance: B.domain,
        authorUsername: frank.username,
      }),
    ]);

    expect(res.status).toBe(200);
    expect(res.body?.accepted).toEqual([]);
    expect(rejectionReason(res, messageId)).toBe('attribution_mismatch');
    expect(dmMessageContents(B)).not.toContain(content);
  });

  it('POSITIVE CONTROL: accepts the same homeward relay once the user holds an account on the peer', async () => {
    const messageId = nextId();
    const content = `attr-homeward-standing-${messageId}`;

    // Byte-identical to the previous case except that erin, unlike frank, wrote
    // a federation-registry row for A over her own authenticated session. If
    // this case did not pass, the previous rejection would prove nothing about
    // attribution — it would just mean homeward relay never works.
    const res = await postSignedRelay(B, identityOrigin(A), secret, [
      createEvent({
        messageId,
        content,
        authorHomeUserId: erin.id,
        authorHomeInstance: B.domain,
        authorUsername: erin.username,
      }),
    ]);

    expect(res.status).toBe(200);
    expect(res.body?.rejected).toEqual([]);
    expect(res.body?.accepted).toContain(messageId);
    expect(dmMessageContents(B)).toContain(content);
  });

  it.each([
    // `pastGuard` is what the handler does with a legitimately-attributed actor
    // once the guard lets it through. dm_close and dm_typing_start swallow an
    // unknown channel silently (accepted); read_state_update reports
    // channel_not_found. Either way the outcome is NOT attribution_mismatch,
    // which is the discriminating fact.
    ['dm_close', dmCloseEvent, 'accepted'],
    ['dm_typing_start', typingEvent, 'accepted'],
    ['read_state_update', readStateEvent, 'channel_not_found'],
  ] as const)(
    'guards %s, which previously ran no attribution step at all',
    async (label, build, pastGuard) => {
      // These handlers gained their guard in this fix. Both halves run against
      // the same handler: a third-instance actor must be refused for
      // attribution, and an actor homed on the signing peer must get PAST the
      // guard — so the refusal cannot be the handler simply refusing everything.
      const hostileId = `${nextId()}-${label}-hostile`;
      const hostile = await postSignedRelay(B, identityOrigin(A), secret, [
        build(hostileId, {
          homeUserId: '900000000000000104',
          homeInstance: THIRD_INSTANCE,
          username: 'mallory',
        }),
      ]);
      expect(hostile.status).toBe(200);
      expect(hostile.body?.accepted).toEqual([]);
      expect(rejectionReason(hostile, hostileId)).toBe('attribution_mismatch');

      const okId = `${nextId()}-${label}-ok`;
      const ok = await postSignedRelay(B, identityOrigin(A), secret, [
        build(okId, {
          homeUserId: '900000000000000105',
          homeInstance: A.domain,
          username: 'alice',
        }),
      ]);
      expect(ok.status).toBe(200);
      // Whatever else happens downstream, the attribution guard did not fire.
      expect(rejectionReason(ok, okId)).not.toBe('attribution_mismatch');
      if (pastGuard === 'accepted') {
        expect(ok.body?.accepted).toContain(okId);
      } else {
        expect(rejectionReason(ok, okId)).toBe(pastGuard);
      }
    },
  );

  it('refuses the hostile event but still processes a valid one in the same batch', async () => {
    const goodId = nextId();
    const badId = nextId();
    const goodContent = `attr-mixed-good-${goodId}`;
    const badContent = `attr-mixed-bad-${badId}`;

    const res = await postSignedRelay(B, identityOrigin(A), secret, [
      createEvent({
        messageId: goodId,
        content: goodContent,
        authorHomeUserId: '900000000000000106',
        authorHomeInstance: A.domain,
        authorUsername: 'alice2',
      }),
      createEvent({
        messageId: badId,
        content: badContent,
        authorHomeUserId: '900000000000000107',
        authorHomeInstance: THIRD_INSTANCE,
        authorUsername: 'mallory',
      }),
    ]);

    expect(res.status).toBe(200);
    expect(res.body?.accepted).toEqual([goodId]);
    expect(rejectionReason(res, badId)).toBe('attribution_mismatch');
    const contents = dmMessageContents(B);
    expect(contents).toContain(goodContent);
    expect(contents).not.toContain(badContent);
  });
});
