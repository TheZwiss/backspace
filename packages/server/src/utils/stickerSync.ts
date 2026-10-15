import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { STICKER_ID_PATTERN } from '@backspace/shared/src/stickers.js';
import { getDb, schema } from '../db/index.js';
import { buildFederationHeaders, getOurOrigin } from './federationAuth.js';
import { assertPeerOriginAllowed, federationFetch } from './federationFetch.js';
import { stickerAssetPath } from './stickerAssets.js';

export interface RemotePackItem {
  assetId: string;
  name: string;
  sortOrder: number;
}

export interface RemotePackPayload {
  id: string;
  name: string;
  description: string | null;
  creatorName: string | null;
  coverAssetId: string | null;
  currentVersion: number;
  items: RemotePackItem[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads a sticker asset from a peer, verifies its SHA-256 hash matches assetId,
 * and publishes it to the local content-addressed sticker asset store.
 */
export async function downloadAndVerifyAsset(peerOrigin: string, assetId: string): Promise<void> {
  if (!STICKER_ID_PATTERN.test(assetId)) {
    throw new Error(`Invalid sticker asset ID: ${assetId}`);
  }

  const localPath = stickerAssetPath(assetId);
  const db = getDb();
  const assetRow = db.select().from(schema.stickerAssets).where(eq(schema.stickerAssets.id, assetId)).get();

  // If already present on disk and in database, skip re-download
  if (assetRow && (await fileExists(localPath))) {
    return;
  }

  const response = await federationFetch(
    peerOrigin,
    `/api/stickers/assets/${assetId}.webp`,
    {
      method: 'GET',
      headers: { Accept: 'image/webp' },
      signal: AbortSignal.timeout(30_000),
    },
    'approved',
  );

  if (!response.ok) {
    throw new Error(`Failed to download sticker asset ${assetId} from ${peerOrigin}: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Content-addressed verification: SHA-256 of downloaded bytes must match assetId
  const computedHash = createHash('sha256').update(buffer).digest('hex');
  if (computedHash !== assetId) {
    throw new Error(`Sticker asset hash mismatch: expected ${assetId}, got ${computedHash}`);
  }

  // Atomically save to local storage
  await mkdir(path.dirname(localPath), { recursive: true });
  const temporaryPath = `${localPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, buffer);
  await rename(temporaryPath, localPath);

  // Ensure record in sticker_assets
  const now = Date.now();
  db.insert(schema.stickerAssets).values({ id: assetId, createdAt: now })
    .onConflictDoUpdate({ target: schema.stickerAssets.id, set: { createdAt: now } }).run();
}

/**
 * Synchronizes a remote sticker pack from an active peer instance into the local replica store.
 */
export async function syncRemotePack(input: {
  peerOrigin: string;
  packId: string;
}): Promise<{ packId: string; replicaId: string; itemCount: number }> {
  const { peerOrigin, packId } = input;
  const db = getDb();

  // 1. Policy check: is peer blocked?
  const policyRow = db.select().from(schema.stickerPeerPolicies)
    .where(eq(schema.stickerPeerPolicies.peerOrigin, peerOrigin)).get();
  if (policyRow && policyRow.policy === 'block') {
    throw new Error('sticker_peer_blocked');
  }

  // 2. Ensure active peered relationship
  const peer = db.select().from(schema.federationPeers)
    .where(and(eq(schema.federationPeers.origin, peerOrigin), eq(schema.federationPeers.status, 'active'))).get();
  if (!peer) {
    throw new Error(`Peer not active or unknown: ${peerOrigin}`);
  }

  await assertPeerOriginAllowed(peerOrigin, 'approved');

  // 3. Query remote pack via S2S
  const queryBody = JSON.stringify({ packId });
  const headers = buildFederationHeaders(queryBody, peer.hmacSecret, getOurOrigin());

  const response = await federationFetch(
    peerOrigin,
    '/api/federation/stickers/packs/get',
    {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: queryBody,
      signal: AbortSignal.timeout(15_000),
    },
    'approved',
  );

  if (!response.ok) {
    throw new Error(`Remote peer returned ${response.status} when querying sticker pack`);
  }

  const remotePack = (await response.json()) as RemotePackPayload;
  if (!remotePack || !remotePack.id || !Array.isArray(remotePack.items)) {
    throw new Error('Malformed remote sticker pack response');
  }

  // 4. Download and verify all sticker assets
  for (const item of remotePack.items) {
    await downloadAndVerifyAsset(peerOrigin, item.assetId);
  }

  if (remotePack.coverAssetId) {
    await downloadAndVerifyAsset(peerOrigin, remotePack.coverAssetId);
  }

  // 5. Store/update in local database
  const now = Date.now();
  const existingReplica = db.select().from(schema.stickerPacks)
    .where(and(
      eq(schema.stickerPacks.sourceInstance, peerOrigin),
      eq(schema.stickerPacks.sourcePackId, packId),
    )).get();

  const replicaId = existingReplica ? existingReplica.id : randomUUID();

  if (existingReplica) {
    db.update(schema.stickerPacks).set({
      name: remotePack.name,
      description: remotePack.description,
      creatorName: remotePack.creatorName,
      coverAssetId: remotePack.coverAssetId,
      currentVersion: remotePack.currentVersion,
      status: 'active',
      syncedAt: now,
      updatedAt: now,
    }).where(eq(schema.stickerPacks.id, replicaId)).run();
  } else {
    db.insert(schema.stickerPacks).values({
      id: replicaId,
      name: remotePack.name,
      description: remotePack.description,
      creatorId: null,
      creatorName: remotePack.creatorName,
      coverAssetId: remotePack.coverAssetId,
      originType: 'replica',
      sourceInstance: peerOrigin,
      sourcePackId: packId,
      currentVersion: remotePack.currentVersion,
      status: 'active',
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  // Create or update version row
  const versionRow = db.select().from(schema.stickerPackVersions)
    .where(and(
      eq(schema.stickerPackVersions.packId, replicaId),
      eq(schema.stickerPackVersions.version, remotePack.currentVersion),
    )).get();

  const versionId = versionRow ? versionRow.id : randomUUID();

  if (!versionRow) {
    db.insert(schema.stickerPackVersions).values({
      id: versionId,
      packId: replicaId,
      version: remotePack.currentVersion,
      name: remotePack.name,
      description: remotePack.description,
      coverAssetId: remotePack.coverAssetId,
      status: 'approved',
      createdAt: now,
    }).run();
  }

  // Replace/insert items for this version
  db.delete(schema.stickerPackItems).where(eq(schema.stickerPackItems.versionId, versionId)).run();

  for (const item of remotePack.items) {
    db.insert(schema.stickerPackItems).values({
      id: randomUUID(),
      packId: replicaId,
      versionId,
      assetId: item.assetId,
      name: item.name,
      sortOrder: item.sortOrder ?? 0,
      status: 'active',
      createdAt: now,
    }).run();
  }

  return { packId, replicaId, itemCount: remotePack.items.length };
}
