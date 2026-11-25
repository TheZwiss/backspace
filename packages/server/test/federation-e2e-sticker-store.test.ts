import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  bootTransportPeered,
  readDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

vi.setConfig({ testTimeout: 60_000 });

async function makeStickerPngBase64(color: { r: number; g: number; b: number }): Promise<string> {
  const buf = await sharp({
    create: { width: 24, height: 24, channels: 4, background: { ...color, alpha: 1 } },
  }).png().toBuffer();
  return buf.toString('base64');
}

function authHeaders(token: string, json = true): Record<string, string> {
  return json
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${token}` };
}

function assetDiskPath(inst: SpawnedInstance, assetId: string): string {
  return path.join(inst.storagePath, 'stickers', `${assetId}.webp`);
}

function hasAssetRow(inst: SpawnedInstance, assetId: string): boolean {
  return readDb(inst, db =>
    Boolean(db.prepare('SELECT 1 FROM sticker_assets WHERE id = ?').get(assetId)),
  );
}

async function createAndApproveSourcePack(
  source: SpawnedInstance,
  creatorToken: string,
  adminToken: string,
  input: {
    name: string;
    stickers: Array<{ name: string; color: { r: number; g: number; b: number } }>;
  },
): Promise<{ packId: string; qualifiedId: string; assetIds: string[] }> {
  const createRes = await fetch(`${source.origin}/api/sticker-packs`, {
    method: 'POST',
    headers: authHeaders(creatorToken),
    body: JSON.stringify({ name: input.name, description: `${input.name} description` }),
  });
  expect(createRes.status).toBe(200);
  const created = await createRes.json() as { id: string; qualifiedId: string };

  const assetIds: string[] = [];
  for (const sticker of input.stickers) {
    const image = await makeStickerPngBase64(sticker.color);
    const itemRes = await fetch(`${source.origin}/api/sticker-packs/${created.id}/items`, {
      method: 'POST',
      headers: authHeaders(creatorToken),
      body: JSON.stringify({ name: sticker.name, image }),
    });
    expect(itemRes.status).toBe(200);
    const item = await itemRes.json() as { assetId: string };
    assetIds.push(item.assetId);
  }

  const submitRes = await fetch(`${source.origin}/api/sticker-packs/${created.id}/submit`, {
    method: 'POST',
    headers: authHeaders(creatorToken, false),
  });
  expect(submitRes.status).toBe(200);

  const approveRes = await fetch(`${source.origin}/api/admin/sticker-packs/${created.id}/approve`, {
    method: 'POST',
    headers: authHeaders(adminToken, false),
  });
  expect(approveRes.status).toBe(200);

  return { packId: created.id, qualifiedId: created.qualifiedId, assetIds };
}

describe('federated sticker store policy change & authoritative removal (two-instance)', () => {
  let h: PeeredHarness;
  /** Authoritative source instance (`remotes[0]`) and receiving instance (`home`). */
  let source: SpawnedInstance;
  let receiver: SpawnedInstance;
  let sourceAdminToken: string;
  let receiverAdminToken: string;
  let authorOnSource: TestUser;
  let memberOnReceiver: TestUser;

  beforeAll(async () => {
    h = await bootTransportPeered(1);
    receiver = h.home;
    source = h.remotes[0]!;
    receiverAdminToken = h.homeAdminToken;
    sourceAdminToken = h.remoteAdminTokens[0]!;

    authorOnSource = await registerLocal(source, 'packauthor');
    memberOnReceiver = await registerLocal(receiver, 'localmember');
  }, 120_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  }, 30_000);

  it('requires explicit peer allow + local approval, and local peer block immediately stops serving and cleans only unreferenced assets', async () => {
    const { packId, qualifiedId, assetIds } = await createAndApproveSourcePack(
      source,
      authorOnSource.token,
      sourceAdminToken,
      {
        name: 'Aurora Cats',
        stickers: [
          { name: 'Exclusive Cat', color: { r: 30, g: 140, b: 220 } },
          { name: 'Collected Cat', color: { r: 220, g: 90, b: 40 } },
        ],
      },
    );
    const [exclusiveAssetId, collectedAssetId] = assetIds as [string, string];

    // 1. Receiving instance defaults to 'block' for newly peered instances.
    const peersBefore = await fetch(`${receiver.origin}/api/admin/federation/stickers/peers`, {
      headers: authHeaders(receiverAdminToken, false),
    });
    expect(peersBefore.status).toBe(200);
    const peerList = await peersBefore.json() as Array<{ origin: string; policy: string }>;
    expect(peerList.find(p => p.origin === source.origin)?.policy).toBe('block');

    const deniedSync = await fetch(`${receiver.origin}/api/admin/federation/stickers/sync`, {
      method: 'POST',
      headers: authHeaders(receiverAdminToken),
      body: JSON.stringify({ peerOrigin: source.origin, packId }),
    });
    expect(deniedSync.status).toBe(403);

    // 2. Receiving admin explicitly allows the peer and stages the remote pack.
    const allowRes = await fetch(
      `${receiver.origin}/api/admin/federation/stickers/peers/${encodeURIComponent(source.origin)}/policy`,
      {
        method: 'PUT',
        headers: authHeaders(receiverAdminToken),
        body: JSON.stringify({ policy: 'allow' }),
      },
    );
    expect(allowRes.status).toBe(200);

    const syncRes = await fetch(`${receiver.origin}/api/admin/federation/stickers/sync`, {
      method: 'POST',
      headers: authHeaders(receiverAdminToken),
      body: JSON.stringify({ peerOrigin: source.origin, packId }),
    });
    expect(syncRes.status).toBe(200);
    const synced = await syncRes.json() as { replicaId: string; status: string };
    expect(synced.status).toBe('pending_review');

    // Pack is NOT served locally until the receiving admin approves it.
    const storeWhilePending = await (await fetch(`${receiver.origin}/api/sticker-store/packs`)).json() as unknown[];
    expect(storeWhilePending).toEqual([]);

    const reviewsRes = await fetch(`${receiver.origin}/api/admin/sticker-packs/reviews`, {
      headers: authHeaders(receiverAdminToken, false),
    });
    const reviews = await reviewsRes.json() as Array<{ id: string; qualifiedId: string }>;
    expect(reviews.some(r => r.id === synced.replicaId && r.qualifiedId === qualifiedId)).toBe(true);

    // 3. Receiving admin approves the replica locally; local user installs it and collects one sticker.
    const approveReplica = await fetch(`${receiver.origin}/api/admin/sticker-packs/${synced.replicaId}/approve`, {
      method: 'POST',
      headers: authHeaders(receiverAdminToken, false),
    });
    expect(approveReplica.status).toBe(200);

    const storeAfterApprove = await (await fetch(`${receiver.origin}/api/sticker-store/packs`)).json() as Array<{
      id: string;
      qualifiedId: string;
      sourceInstance: string;
      sourcePackId: string;
    }>;
    expect(storeAfterApprove).toHaveLength(1);
    expect(storeAfterApprove[0]).toMatchObject({
      id: synced.replicaId,
      qualifiedId: `${source.origin}/api/sticker-packs/${packId}`,
      sourceInstance: source.origin,
      sourcePackId: packId,
    });

    const installRes = await fetch(`${receiver.origin}/api/sticker-store/packs/${synced.replicaId}/install`, {
      method: 'POST',
      headers: authHeaders(memberOnReceiver.token, false),
    });
    expect(installRes.status).toBe(200);

    // Local user collects `collectedAssetId` into personal_stickers so it holds an independent reference.
    const collectRes = await fetch(`${receiver.origin}/api/stickers/${collectedAssetId}/collect`, {
      method: 'POST',
      headers: authHeaders(memberOnReceiver.token),
      body: JSON.stringify({
        token: `sticker:${receiver.origin}/api/stickers/assets/${collectedAssetId}.webp`,
        name: 'Saved Cat',
      }),
    });
    expect(collectRes.status).toBe(200);

    expect(fs.existsSync(assetDiskPath(receiver, exclusiveAssetId))).toBe(true);
    expect(fs.existsSync(assetDiskPath(receiver, collectedAssetId))).toBe(true);

    // 4. Policy change: receiving admin blocks the peer.
    const blockRes = await fetch(
      `${receiver.origin}/api/admin/federation/stickers/peers/${encodeURIComponent(source.origin)}/policy`,
      {
        method: 'PUT',
        headers: authHeaders(receiverAdminToken),
        body: JSON.stringify({ policy: 'block' }),
      },
    );
    expect(blockRes.status).toBe(200);

    // Immediate effect on store, detail, and installed packs.
    const storeAfterBlock = await (await fetch(`${receiver.origin}/api/sticker-store/packs`)).json() as unknown[];
    expect(storeAfterBlock).toEqual([]);
    const detailAfterBlock = await fetch(`${receiver.origin}/api/sticker-store/packs/${synced.replicaId}`);
    expect(detailAfterBlock.status).toBe(404);
    const myPacksAfterBlock = await (await fetch(`${receiver.origin}/api/sticker-store/my-packs`, {
      headers: authHeaders(memberOnReceiver.token, false),
    })).json() as unknown[];
    expect(myPacksAfterBlock).toEqual([]);

    // Unreferenced replicated asset is cleaned up; collected asset remains intact!
    expect(fs.existsSync(assetDiskPath(receiver, exclusiveAssetId))).toBe(false);
    expect(hasAssetRow(receiver, exclusiveAssetId)).toBe(false);
    expect((await fetch(`${receiver.origin}/api/stickers/assets/${exclusiveAssetId}.webp`)).status).toBe(404);

    expect(fs.existsSync(assetDiskPath(receiver, collectedAssetId))).toBe(true);
    expect(hasAssetRow(receiver, collectedAssetId)).toBe(true);
    expect((await fetch(`${receiver.origin}/api/stickers/assets/${collectedAssetId}.webp`)).status).toBe(200);
  });

  it('stops serving a replicated pack after authoritative peer removal + reconciliation, cleaning only unreferenced assets', async () => {
    // Re-allow source peer on receiver.
    const reallowRes = await fetch(
      `${receiver.origin}/api/admin/federation/stickers/peers/${encodeURIComponent(source.origin)}/policy`,
      {
        method: 'PUT',
        headers: authHeaders(receiverAdminToken),
        body: JSON.stringify({ policy: 'allow' }),
      },
    );
    expect(reallowRes.status).toBe(200);

    const { packId, assetIds } = await createAndApproveSourcePack(
      source,
      authorOnSource.token,
      sourceAdminToken,
      {
        name: 'Nebula Dogs',
        stickers: [
          { name: 'Pack-Only Dog', color: { r: 70, g: 200, b: 120 } },
          { name: 'Posted Dog', color: { r: 160, g: 60, b: 210 } },
        ],
      },
    );
    const [unreferencedDogId, messageDogId] = assetIds as [string, string];

    // Sync & approve on receiver.
    const syncRes = await fetch(`${receiver.origin}/api/admin/federation/stickers/sync`, {
      method: 'POST',
      headers: authHeaders(receiverAdminToken),
      body: JSON.stringify({ peerOrigin: source.origin, packId }),
    });
    expect(syncRes.status).toBe(200);
    const { replicaId } = await syncRes.json() as { replicaId: string };

    const approveRes = await fetch(`${receiver.origin}/api/admin/sticker-packs/${replicaId}/approve`, {
      method: 'POST',
      headers: authHeaders(receiverAdminToken, false),
    });
    expect(approveRes.status).toBe(200);

    await fetch(`${receiver.origin}/api/sticker-store/packs/${replicaId}/install`, {
      method: 'POST',
      headers: authHeaders(memberOnReceiver.token, false),
    });

    // Create a space on receiver and post `messageDogId` as a channel sticker message.
    const spaceRes = await fetch(`${receiver.origin}/api/spaces`, {
      method: 'POST',
      headers: authHeaders(memberOnReceiver.token),
      body: JSON.stringify({ name: 'Dog Fans' }),
    });
    expect(spaceRes.status).toBe(201);
    const space = await spaceRes.json() as { id: string };

    const spaceDetailRes = await fetch(`${receiver.origin}/api/spaces/${space.id}`, {
      headers: authHeaders(memberOnReceiver.token, false),
    });
    const spaceDetail = await spaceDetailRes.json() as { channels: Array<{ id: string; type: string }> };
    const textChannel = spaceDetail.channels.find(c => c.type === 'text')!;

    const msgRes = await fetch(`${receiver.origin}/api/channels/${textChannel.id}/messages`, {
      method: 'POST',
      headers: authHeaders(memberOnReceiver.token),
      body: JSON.stringify({
        content: `sticker:${receiver.origin}/api/stickers/assets/${messageDogId}.webp`,
      }),
    });
    expect(msgRes.status).toBe(201);

    // Authoritative peer deletes the pack.
    const deleteOnSource = await fetch(`${source.origin}/api/sticker-packs/${packId}`, {
      method: 'DELETE',
      headers: authHeaders(authorOnSource.token, false),
    });
    expect(deleteOnSource.status).toBe(200);

    // Reconcile on receiving instance.
    const reconcileRes = await fetch(`${receiver.origin}/api/admin/federation/stickers/reconcile`, {
      method: 'POST',
      headers: authHeaders(receiverAdminToken),
      body: JSON.stringify({ peerOrigin: source.origin }),
    });
    expect(reconcileRes.status).toBe(200);
    const reconciled = await reconcileRes.json() as {
      results: Array<{ removedPackIds: string[]; cleanedFiles: number }>;
    };
    expect(reconciled.results[0]?.removedPackIds).toContain(replicaId);
    expect(reconciled.results[0]?.cleanedFiles).toBe(1);

    // Replicated pack is no longer served anywhere on receiver.
    const storeAfterReconcile = await (await fetch(`${receiver.origin}/api/sticker-store/packs`)).json() as unknown[];
    expect(storeAfterReconcile).toEqual([]);
    expect((await fetch(`${receiver.origin}/api/sticker-store/packs/${replicaId}`)).status).toBe(404);
    const myPacksAfterReconcile = await (await fetch(`${receiver.origin}/api/sticker-store/my-packs`, {
      headers: authHeaders(memberOnReceiver.token, false),
    })).json() as unknown[];
    expect(myPacksAfterReconcile).toEqual([]);

    // Unreferenced asset was removed; message-referenced asset still serves 200!
    expect(fs.existsSync(assetDiskPath(receiver, unreferencedDogId))).toBe(false);
    expect(hasAssetRow(receiver, unreferencedDogId)).toBe(false);
    expect((await fetch(`${receiver.origin}/api/stickers/assets/${unreferencedDogId}.webp`)).status).toBe(404);

    expect(fs.existsSync(assetDiskPath(receiver, messageDogId))).toBe(true);
    expect(hasAssetRow(receiver, messageDogId)).toBe(true);
    expect((await fetch(`${receiver.origin}/api/stickers/assets/${messageDogId}.webp`)).status).toBe(200);
  });
});
