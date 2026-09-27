import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  queuedRelayEvents,
  rejectionReason,
  sendDmMessage,
  readDb,
  withWritableDb,
  type PeeredHarness,
  type RelayPostResult,
} from './helpers/federationE2E.js';
import { registerLocal, createFederatedUser, type TestUser } from './helpers/testUsers.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances over real HTTP; the 5s unit default is too tight.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate: relayed edits and deletes name the message they change ─────────
 *
 * Every instance holds its own copy of a federated DM message under its own
 * local id. An edit or delete relay used to carry only the SENDER's local id,
 * and the receiver looked it up as `(sourceInstance, id)`. That only finds the
 * message when the sender is the instance that created it. Edit or delete a
 * message from the other instance than the one it was sent through, and the
 * relay was rejected as `unknown_message` forever, so the two copies diverged.
 *
 * The relay now carries `target`: the message in shared coordinates
 * (`dmMessageFederationRef`), the conversation's `federatedId`, and the acting
 * identity. The receiver resolves it inside that conversation and applies the
 * change only when the actor IS the message's author, compared as federated
 * identities (home user id + home instance), and the actor passes the usual
 * attribution check. Old senders still send only the local id; that lookup is
 * kept as the fallback.
 *
 * Topology (IDENTITY profile, so B's inbound relay handling is fully real):
 *   alice — native on A, with a federated account on B
 *   dave  — native on B, with a federated account on A
 *   bob   — native on B (only in a second conversation, for scoping)
 * The alice–dave conversation exists on both instances. A's real update and
 * delete events are read from A's outbox and posted, signed, to B.
 *
 * Planted rows: A's relayed copies of messages created on B. B's worker would
 * deliver those to A; this profile cannot deliver into A.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secretOnB: string;

let alice: TestUser;
let aliceOnB: TestUser;
let dave: TestUser;
let daveOnA: TestUser;
let bob: TestUser;

let dmOnA: string;
let dmOnB: string;

/** Create a message natively on B and plant A's relayed copy of it. Returns [idOnB, idOnA]. */
async function createOnBMirroredToA(
  author: TestUser,
  authorOnAId: string,
  content: string,
): Promise<[string, string]> {
  const sent = await sendDmMessage(B, author.token, dmOnB, { content });
  if (sent.status !== 201 || !sent.id) throw new Error(`send on B failed: ${sent.status}`);
  const idOnA = `e2e-mirror-${Math.floor(Math.random() * 1e9)}`;
  withWritableDb(A, db => {
    db.prepare(`
      INSERT INTO dm_messages (id, dm_channel_id, user_id, content, type, reply_to_id, created_at,
                               source_instance, source_message_id, encryption_version)
      VALUES (?, ?, ?, ?, 'user', NULL, ?, ?, ?, 0)
    `).run(idOnA, dmOnA, authorOnAId, content, Date.now(), identityOrigin(B), sent.id);
  });
  return [sent.id, idOnA];
}

/** Create a message natively on A and deliver A's real create event to B. Returns [idOnA, idOnB]. */
async function createOnADeliveredToB(content: string): Promise<[string, string]> {
  const sent = await sendDmMessage(A, alice.token, dmOnA, { content });
  if (sent.status !== 201 || !sent.id) throw new Error(`send on A failed: ${sent.status}`);
  const create = queuedRelayEvents(A, dmOnA, 'create').find(e => e.messageId === sent.id);
  const res = await postSignedRelay(B, identityOrigin(A), secretOnB, [create!]);
  if (!res.body?.accepted.includes(sent.id)) throw new Error(`create not accepted: ${res.raw}`);
  // What A's worker does with an accepted entry. Left queued, a later edit
  // would coalesce into this create instead of being relayed as an update.
  withWritableDb(A, db => {
    db.prepare('DELETE FROM federation_outbox WHERE entity_id = ?').run(sent.id);
  });
  return [sent.id, contentRowOnB(content)!.id];
}

async function editOnA(token: string, idOnA: string, content: string): Promise<void> {
  const res = await fetch(`${A.origin}/api/dm/messages/${idOnA}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(200);
}

async function deleteOnA(token: string, idOnA: string): Promise<void> {
  const res = await fetch(`${A.origin}/api/dm/messages/${idOnA}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBeLessThan(300);
}

/** The event A queued for `idOnA`, as its worker would send it. */
function queuedOnA(eventType: 'update' | 'delete', idOnA: string): FederationRelayEvent {
  const event = queuedRelayEvents(A, dmOnA, eventType).find(e => e.messageId === idOnA);
  if (!event) throw new Error(`A queued no ${eventType} for ${idOnA}`);
  return event;
}

/** The event as a sender without `target` support builds it. */
function withoutTarget(event: FederationRelayEvent): FederationRelayEvent {
  const copy: FederationRelayEvent = { ...event };
  delete copy.target;
  return copy;
}

function relayToB(events: FederationRelayEvent[]): Promise<RelayPostResult> {
  return postSignedRelay(B, identityOrigin(A), secretOnB, events);
}

function rowOnB(id: string): { content: string | null; editedAt: number | null } | undefined {
  return readDb(B, db =>
    db.prepare('SELECT content, edited_at AS editedAt FROM dm_messages WHERE id = ?').get(id) as
      { content: string | null; editedAt: number | null } | undefined,
  );
}

function contentRowOnB(content: string): { id: string } | undefined {
  return readDb(B, db =>
    db.prepare('SELECT id FROM dm_messages WHERE content = ?').get(content) as { id: string } | undefined,
  );
}

let daveProofOnFile = false;

/**
 * dave's account on A is how dave acts on A. His home only accepts events A
 * attributes to him once it holds the proof that he has that account: his
 * registry on B naming A by the origin A signs with (the helper recorded A's
 * transport url, which is not it). Until then a homeward event is
 * `attribution_unproven`.
 */
async function putDaveProofOnFile(): Promise<void> {
  if (daveProofOnFile) return;
  const registry = await fetch(`${B.origin}/api/users/@me/federation-registry`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dave.token}` },
    body: JSON.stringify({
      updatedAt: Date.now() + 1_000,
      registry: [{
        origin: identityOrigin(A), label: A.domain, username: daveOnA.username,
        remoteUserId: daveOnA.id, status: 'connected', addedAt: Date.now(), lastConnectedAt: Date.now(),
      }],
    }),
  });
  if (!registry.ok) throw new Error(`registry PUT failed: ${registry.status} ${await registry.text()}`);
  daveProofOnFile = true;
}

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  secretOnB = peerSecretOn(B, identityOrigin(A));

  ({ homeUser: alice, remoteUser: aliceOnB } = await createFederatedUser(A, B, 'alice'));
  ({ homeUser: dave, remoteUser: daveOnA } = await createFederatedUser(B, A, 'dave'));
  bob = await registerLocal(B, 'bob');


  const created = await fetch(`${A.origin}/api/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ homeUserId: dave.id, homeInstance: B.domain }),
  });
  if (created.status !== 201 && created.status !== 200) throw new Error(`federated DM create failed: ${created.status}`);
  dmOnA = (await created.json() as { id: string }).id;

  await createOnADeliveredToB('opener from alice');
  dmOnB = readDb(B, db =>
    db.prepare('SELECT dm_channel_id AS ch FROM dm_messages WHERE content = ?').get('opener from alice') as { ch: string },
  ).ch;
}, 90_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — relayed edits and deletes reach the message they change', () => {
  it('setup control: one conversation, the same participants on both sides', () => {
    const membersA = readDb(A, db =>
      db.prepare('SELECT user_id AS id FROM dm_members WHERE dm_channel_id = ?').all(dmOnA) as { id: string }[],
    ).map(m => m.id).sort();
    const membersB = readDb(B, db =>
      db.prepare('SELECT user_id AS id FROM dm_members WHERE dm_channel_id = ?').all(dmOnB) as { id: string }[],
    ).map(m => m.id).sort();
    expect(membersA).toEqual([alice.id, daveOnA.id].sort());
    expect(membersB).toEqual([aliceOnB.id, dave.id].sort());
  });

  it('alice sends through B, then edits and deletes from home: B applies both', async () => {
    const [editOnB, editMirror] = await createOnBMirroredToA(aliceOnB, alice.id, 'alice via B, to edit');
    await editOnA(alice.token, editMirror, 'alice via B, edited at home');
    const edit = await relayToB([queuedOnA('update', editMirror)]);
    expect(edit.body?.accepted).toContain(editMirror);
    expect(rowOnB(editOnB)?.content).toBe('alice via B, edited at home');

    const [delOnB, delMirror] = await createOnBMirroredToA(aliceOnB, alice.id, 'alice via B, to delete');
    await deleteOnA(alice.token, delMirror);
    const del = await relayToB([queuedOnA('delete', delMirror)]);
    expect(del.body?.accepted).toContain(delMirror);
    expect(rowOnB(delOnB)).toBeUndefined();
  });

  it('dave\'s edit through A before his proof reaches B is attribution_unproven, and applies once it has', async () => {
    const [idOnB, mirror] = await createOnBMirroredToA(dave, daveOnA.id, 'dave, edited before proof');
    await editOnA(daveOnA.token, mirror, 'dave, edit waited for proof');
    const edit = queuedOnA('update', mirror);

    const early = await postSignedRelay(B, identityOrigin(A), secretOnB, [edit], { capabilities: ['attribution_unproven'] });
    expect(rejectionReason(early, mirror)).toBe('attribution_unproven');
    expect(rowOnB(idOnB)).toEqual({ content: 'dave, edited before proof', editedAt: null });

    // The retry the sender makes after its backoff, once the proof is on file.
    await putDaveProofOnFile();
    const retried = await postSignedRelay(B, identityOrigin(A), secretOnB, [edit], { capabilities: ['attribution_unproven'] });
    expect(retried.body?.accepted).toContain(mirror);
    expect(rowOnB(idOnB)?.content).toBe('dave, edit waited for proof');
  });

  it('dave sends at home on B, then edits and deletes through his account on A: B applies both', async () => {
    await putDaveProofOnFile();
    const [editOnB, editMirror] = await createOnBMirroredToA(dave, daveOnA.id, 'dave at home, to edit');
    await editOnA(daveOnA.token, editMirror, 'dave at home, edited via A');
    const edit = await relayToB([queuedOnA('update', editMirror)]);
    expect(edit.body?.accepted).toContain(editMirror);
    expect(rowOnB(editOnB)?.content).toBe('dave at home, edited via A');

    const [delOnB, delMirror] = await createOnBMirroredToA(dave, daveOnA.id, 'dave at home, to delete');
    await deleteOnA(daveOnA.token, delMirror);
    const del = await relayToB([queuedOnA('delete', delMirror)]);
    expect(del.body?.accepted).toContain(delMirror);
    expect(rowOnB(delOnB)).toBeUndefined();
  });

  it('a message created and edited on the same instance still applies (the receiver holds the relayed copy)', async () => {
    const [idOnA, idOnB] = await createOnADeliveredToB('alice at home, to edit');
    await editOnA(alice.token, idOnA, 'alice at home, edited');
    const edit = await relayToB([queuedOnA('update', idOnA)]);
    expect(edit.body?.accepted).toContain(idOnA);
    expect(rowOnB(idOnB)?.content).toBe('alice at home, edited');
  });
});

describe('federation e2e — a relayed edit or delete must come from the message\'s author', () => {
  it('an edit A relays for dave\'s message, attributed to alice, is refused and changes nothing', async () => {
    const [daveMsgOnB] = await createOnBMirroredToA(dave, daveOnA.id, 'dave, not alice\'s to edit');
    // A legitimate edit event from A, re-aimed at dave's message.
    const [ownOnA] = await createOnADeliveredToB('alice, template for forgery');
    await editOnA(alice.token, ownOnA, 'forged content');
    const template = queuedOnA('update', ownOnA);
    expect(template.target).toBeDefined();
    const forged: FederationRelayEvent = {
      ...template,
      messageId: `forged-edit-${Date.now()}`,
      target: { ...template.target!, message: { messageId: daveMsgOnB, messageHomeInstance: identityOrigin(B) } },
    };

    const res = await relayToB([forged]);
    expect(rejectionReason(res, forged.messageId)).toBe('not_message_author');
    expect(rowOnB(daveMsgOnB)).toEqual({ content: 'dave, not alice\'s to edit', editedAt: null });
  });

  it('a delete A relays for dave\'s message, attributed to alice, is refused and deletes nothing', async () => {
    const [daveMsgOnB] = await createOnBMirroredToA(dave, daveOnA.id, 'dave, not alice\'s to delete');
    const [ownOnA] = await createOnADeliveredToB('alice, delete template');
    await deleteOnA(alice.token, ownOnA);
    const template = queuedOnA('delete', ownOnA);
    expect(template.target).toBeDefined();
    const forged: FederationRelayEvent = {
      ...template,
      messageId: `forged-delete-${Date.now()}`,
      target: { ...template.target!, message: { messageId: daveMsgOnB, messageHomeInstance: identityOrigin(B) } },
    };

    const res = await relayToB([forged]);
    expect(rejectionReason(res, forged.messageId)).toBe('not_message_author');
    expect(rowOnB(daveMsgOnB)?.content).toBe('dave, not alice\'s to delete');
  });

  it('an edit naming alice\'s own message in another conversation is not applied there', async () => {
    const other = await fetch(`${B.origin}/api/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ userId: aliceOnB.id }),
    });
    const otherDm = (await other.json() as { id: string }).id;
    const elsewhere = await sendDmMessage(B, aliceOnB.token, otherDm, { content: 'alice to bob' });
    expect(elsewhere.status).toBe(201);

    const [ownOnA] = await createOnADeliveredToB('alice, scope template');
    await editOnA(alice.token, ownOnA, 'rewritten elsewhere');
    const template = queuedOnA('update', ownOnA);
    const forged: FederationRelayEvent = {
      ...template,
      messageId: `forged-scope-${Date.now()}`,
      target: { ...template.target!, message: { messageId: elsewhere.id!, messageHomeInstance: identityOrigin(B) } },
    };

    const res = await relayToB([forged]);
    expect(res.body?.accepted).not.toContain(forged.messageId);
    expect(rowOnB(elsewhere.id!)?.content).toBe('alice to bob');
  });
});

describe('federation e2e — a relayed target is only accepted from the conversation\'s own peers', () => {
  /**
   * dave (native on B) and bob (native on B) in a conversation B never relays
   * to A: no participant lives on A, so A is not one of its target origins.
   * The federatedId stands in for a conversation B shares with some other
   * instance (or one whose A participant has left): it is what makes the
   * conversation addressable by `target` at all. A may act for dave (his
   * proof is on file), and dave wrote the message, so attribution and the
   * author check both pass. A still has no business changing it.
   */
  async function daveBobMessageOnB(content: string): Promise<string> {
    const created = await fetch(`${B.origin}/api/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dave.token}` },
      body: JSON.stringify({ userId: bob.id }),
    });
    if (created.status !== 201 && created.status !== 200) throw new Error(`dave-bob DM create failed: ${created.status}`);
    const dmId = (await created.json() as { id: string }).id;
    withWritableDb(B, db => {
      db.prepare('UPDATE dm_channels SET federated_id = COALESCE(federated_id, ?) WHERE id = ?')
        .run(`not-shared-with-a-${dmId}`, dmId);
    });
    const sent = await sendDmMessage(B, dave.token, dmId, { content });
    if (sent.status !== 201 || !sent.id) throw new Error(`send on B failed: ${sent.status}`);
    return sent.id;
  }

  function federatedIdOnB(messageId: string): string {
    return readDb(B, db =>
      db.prepare(`
        SELECT c.federated_id AS fid FROM dm_messages m JOIN dm_channels c ON c.id = m.dm_channel_id WHERE m.id = ?
      `).get(messageId) as { fid: string },
    ).fid;
  }

  it('the instance a message came from may still edit and delete it after it stopped being a peer', async () => {
    await putDaveProofOnFile();
    // A message dave sent through his account on A, relayed to B while A was
    // still a peer of the conversation. A no longer is (its participant left),
    // but the message is A's: B holds it as (source A, A's id).
    const anchorOnB = await daveBobMessageOnB('dave to bob, anchor');
    const dmId = readDb(B, db =>
      db.prepare('SELECT dm_channel_id AS ch FROM dm_messages WHERE id = ?').get(anchorOnB) as { ch: string },
    ).ch;
    const plant = (content: string): [string, string] => {
      const idOnB = `e2e-from-a-${Math.floor(Math.random() * 1e9)}`;
      const idOnA = `e2e-a-id-${Math.floor(Math.random() * 1e9)}`;
      withWritableDb(B, db => {
        db.prepare(`
          INSERT INTO dm_messages (id, dm_channel_id, user_id, content, type, reply_to_id, created_at,
                                   source_instance, source_message_id, encryption_version)
          VALUES (?, ?, ?, ?, 'user', NULL, ?, ?, ?, 0)
        `).run(idOnB, dmId, dave.id, content, Date.now(), identityOrigin(A), idOnA);
      });
      return [idOnB, idOnA];
    };
    const aimAt = (template: FederationRelayEvent, idOnA: string, idOnB: string): FederationRelayEvent => ({
      ...template,
      messageId: `own-source-${template.eventType}-${Date.now()}`,
      target: {
        ...template.target!,
        federatedId: federatedIdOnB(idOnB),
        message: { messageId: idOnA, messageHomeInstance: identityOrigin(A) },
      },
    });

    const [editOnB, editIdOnA] = plant('dave via A, to edit');
    const [, editMirror] = await createOnBMirroredToA(dave, daveOnA.id, 'dave, own-source edit template');
    await editOnA(daveOnA.token, editMirror, 'dave via A, edited from A');
    const edit = aimAt(queuedOnA('update', editMirror), editIdOnA, editOnB);
    const editRes = await relayToB([edit]);
    expect(editRes.body?.accepted).toContain(edit.messageId);
    expect(rowOnB(editOnB)?.content).toBe('dave via A, edited from A');

    const [delOnB, delIdOnA] = plant('dave via A, to delete');
    const [, delMirror] = await createOnBMirroredToA(dave, daveOnA.id, 'dave, own-source delete template');
    await deleteOnA(daveOnA.token, delMirror);
    const del = aimAt(queuedOnA('delete', delMirror), delIdOnA, delOnB);
    const delRes = await relayToB([del]);
    expect(delRes.body?.accepted).toContain(del.messageId);
    expect(rowOnB(delOnB)).toBeUndefined();
  });

  it('an edit of dave\'s message in a conversation A is not a peer of is refused and changes nothing', async () => {
    await putDaveProofOnFile();
    const targetOnB = await daveBobMessageOnB('dave to bob, not A\'s to edit');
    const [, mirror] = await createOnBMirroredToA(dave, daveOnA.id, 'dave, edit template');
    await editOnA(daveOnA.token, mirror, 'rewritten by A');
    const template = queuedOnA('update', mirror);
    expect(template.target).toBeDefined();
    const aimed: FederationRelayEvent = {
      ...template,
      messageId: `outsider-edit-${Date.now()}`,
      target: {
        ...template.target!,
        federatedId: federatedIdOnB(targetOnB),
        message: { messageId: targetOnB, messageHomeInstance: identityOrigin(B) },
      },
    };

    const res = await relayToB([aimed]);
    expect(rejectionReason(res, aimed.messageId)).toBe('invalid_target');
    expect(rowOnB(targetOnB)).toEqual({ content: 'dave to bob, not A\'s to edit', editedAt: null });
  });

  it('a delete of dave\'s message in a conversation A is not a peer of is refused and deletes nothing', async () => {
    await putDaveProofOnFile();
    const targetOnB = await daveBobMessageOnB('dave to bob, not A\'s to delete');
    const [, mirror] = await createOnBMirroredToA(dave, daveOnA.id, 'dave, delete template');
    await deleteOnA(daveOnA.token, mirror);
    const template = queuedOnA('delete', mirror);
    expect(template.target).toBeDefined();
    const aimed: FederationRelayEvent = {
      ...template,
      messageId: `outsider-delete-${Date.now()}`,
      target: {
        ...template.target!,
        federatedId: federatedIdOnB(targetOnB),
        message: { messageId: targetOnB, messageHomeInstance: identityOrigin(B) },
      },
    };

    const res = await relayToB([aimed]);
    expect(rejectionReason(res, aimed.messageId)).toBe('invalid_target');
    expect(rowOnB(targetOnB)?.content).toBe('dave to bob, not A\'s to delete');
  });
});

describe('federation e2e — events from senders without `target` still apply', () => {
  it('an old-shape edit and delete (local id only) of a message the sender created are applied', async () => {
    const [idOnA, idOnB] = await createOnADeliveredToB('old shape, to edit');
    await editOnA(alice.token, idOnA, 'old shape, edited');
    const oldEdit = withoutTarget(queuedOnA('update', idOnA));
    const edit = await relayToB([oldEdit]);
    expect(edit.body?.accepted).toContain(idOnA);
    expect(rowOnB(idOnB)?.content).toBe('old shape, edited');

    const [delOnA, delOnB] = await createOnADeliveredToB('old shape, to delete');
    await deleteOnA(alice.token, delOnA);
    const oldDelete = withoutTarget(queuedOnA('delete', delOnA));
    const del = await relayToB([oldDelete]);
    expect(del.body?.accepted).toContain(delOnA);
    expect(rowOnB(delOnB)).toBeUndefined();
  });
});
