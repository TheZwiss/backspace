import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { STICKER_ID_PATTERN, stripTrailingSlashes } from '@backspace/shared/src/stickers.js';
import { getDb, schema } from '../db/index.js';
import { buildFederationHeaders, getOurOrigin } from './federationAuth.js';
import { assertPeerOriginAllowed, federationFetch } from './federationFetch.js';
import {
  cleanupUnreferencedStickerAssets,
  collectPackAssetIds,
  stickerAssetPath,
  type StickerCleanupResult,
} from './stickerAssets.js';

export interface RemotePackItem {
  assetId: string;
  name: string;
  sortOrder: number;
}

export interface RemotePackPayload {
  id: string;
  origin?: string;
  qualifiedId?: string;
  name: string;
  description: string | null;
  creatorName: string | null;
  coverAssetId: string | null;
  currentVersion: number;
  items: RemotePackItem[];
}

export interface RemotePackListSummary {
  id: string;
  origin?: string;
  qualifiedId?: string;
  name: string;
  description: string | null;
  creatorName: string | null;
  coverAssetId: string | null;
  currentVersion: number;
  itemCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReconcilePeerStickersResult {
  peerOrigin: string;
  removedPackIds: string[];
  syncedPackIds: string[];
  cleanedFiles: number;
  freedBytes: number;
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
 * Receiving instances deny remote sticker packs unless an administrator has
 * explicitly configured `policy = 'allow'` for the peer origin.
 */
export function isStickerPeerAllowed(peerOrigin: string): boolean {
  const row = getDb().select({ policy: schema.stickerPeerPolicies.policy })
    .from(schema.stickerPeerPolicies)
    .where(eq(schema.stickerPeerPolicies.peerOrigin, peerOrigin))
    .get();
  return row?.policy === 'allow';
}

/**
 * Transitions the given sticker packs into `'deleted'` or `'blocked'`, drops
 * their installs, versions, and item rows so foreign-key restrictions release,
 * and immediately cleans up any assets that have no other live reference.
 */
export function purgeStickerPacksAssetsAndData(
  packIds: string[],
  nextStatus: 'deleted' | 'blocked',
  now: number = Date.now(),
): StickerCleanupResult {
  if (packIds.length === 0) return { deletedFiles: 0, freedBytes: 0, errors: [] };
  const db = getDb();
  const candidateAssetIds = collectPackAssetIds(packIds);

  db.transaction((tx) => {
    tx.delete(schema.userInstalledPacks).where(inArray(schema.userInstalledPacks.packId, packIds)).run();
    tx.delete(schema.stickerPackItems).where(inArray(schema.stickerPackItems.packId, packIds)).run();
    tx.delete(schema.stickerPackVersions).where(inArray(schema.stickerPackVersions.packId, packIds)).run();
    tx.update(schema.stickerPacks)
      .set({
        status: nextStatus,
        coverAssetId: null,
        updatedAt: now,
      })
      .where(inArray(schema.stickerPacks.id, packIds))
      .run();
  });

  return cleanupUnreferencedStickerAssets(candidateAssetIds, false);
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

  const buffer = Buffer.from(await response.arrayBuffer());
  const computedHash = createHash('sha256').update(buffer).digest('hex');
  if (computedHash !== assetId) {
    throw new Error(`Sticker asset hash mismatch: expected ${assetId}, got ${computedHash}`);
  }

  await mkdir(path.dirname(localPath), { recursive: true });
  const temporaryPath = `${localPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, buffer);
  await rename(temporaryPath, localPath);

  const now = Date.now();
  db.insert(schema.stickerAssets).values({ id: assetId, createdAt: now })
    .onConflictDoUpdate({ target: schema.stickerAssets.id, set: { createdAt: now } }).run();
}

function upsertPendingReplicaVersion(input: {
  replicaId: string;
  remotePack: RemotePackPayload;
  now: number;
}): string {
  const { replicaId, remotePack, now } = input;
  const db = getDb();
  const existingVersion = db.select().from(schema.stickerPackVersions)
    .where(and(
      eq(schema.stickerPackVersions.packId, replicaId),
      eq(schema.stickerPackVersions.version, remotePack.currentVersion),
    ))
    .get();

  const versionId = existingVersion ? existingVersion.id : randomUUID();
  if (existingVersion) {
    db.update(schema.stickerPackVersions).set({
      name: remotePack.name,
      description: remotePack.description,
      coverAssetId: remotePack.coverAssetId,
      status: existingVersion.status === 'approved' ? 'approved' : 'pending_review',
    }).where(eq(schema.stickerPackVersions.id, versionId)).run();
  } else {
    db.insert(schema.stickerPackVersions).values({
      id: versionId,
      packId: replicaId,
      version: remotePack.currentVersion,
      name: remotePack.name,
      description: remotePack.description,
      coverAssetId: remotePack.coverAssetId,
      status: 'pending_review',
      createdAt: now,
    }).run();
  }

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

  return versionId;
}

/**
 * Synchronizes a remote sticker pack from an explicitly allowed active peer into
 * the local replica store. Replicated packs and new versions enter `pending_review`
 * and require explicit local admin approval before becoming available locally.
 */
export async function syncRemotePack(input: {
  peerOrigin: string;
  packId: string;
}): Promise<{ packId: string; replicaId: string; itemCount: number; status: string }> {
  const db = getDb();

  // 1. Explicit peer allow check (default-deny).
  if (!isStickerPeerAllowed(input.peerOrigin)) {
    throw new Error('sticker_peer_blocked');
  }

  // 2. Resolve active peer row and address outbound calls strictly via stored peer.origin.
  const peer = db.select().from(schema.federationPeers)
    .where(and(eq(schema.federationPeers.origin, input.peerOrigin), eq(schema.federationPeers.status, 'active')))
    .get();
  if (!peer) {
    throw new Error(`Peer not active or unknown: ${input.peerOrigin}`);
  }
  const canonicalOrigin = peer.origin;
  const sourcePackId = input.packId.trim();
  if (!sourcePackId) {
    throw new Error('Invalid remote sticker pack ID');
  }

  const existingReplica = db.select().from(schema.stickerPacks)
    .where(and(
      eq(schema.stickerPacks.sourceInstance, canonicalOrigin),
      eq(schema.stickerPacks.sourcePackId, sourcePackId),
    ))
    .get();

  if (existingReplica?.status === 'blocked') {
    throw new Error('sticker_peer_blocked');
  }

  await assertPeerOriginAllowed(canonicalOrigin, 'approved');

  // 3. Query authoritative peer via S2S HMAC.
  const queryBody = JSON.stringify({ packId: sourcePackId });
  const headers = buildFederationHeaders(queryBody, peer.hmacSecret, getOurOrigin());
  const response = await federationFetch(
    canonicalOrigin,
    '/api/federation/stickers/packs/get',
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: queryBody,
      signal: AbortSignal.timeout(15_000),
    },
    'approved',
  );

  if (response.status === 404) {
    if (existingReplica && existingReplica.status !== 'deleted') {
      purgeStickerPacksAssetsAndData([existingReplica.id], 'deleted');
    }
    throw new Error('sticker_pack_not_found');
  }

  if (!response.ok) {
    throw new Error(`Remote peer returned ${response.status} when querying sticker pack`);
  }

  const remotePack = (await response.json()) as RemotePackPayload;
  if (!remotePack || remotePack.id !== sourcePackId || !Array.isArray(remotePack.items)) {
    throw new Error('Malformed remote sticker pack response');
  }
  if (remotePack.origin && stripTrailingSlashes(remotePack.origin) !== stripTrailingSlashes(canonicalOrigin)) {
    throw new Error('Authoritative origin mismatch for remote sticker pack');
  }

  // 4. Download and verify content-addressed sticker assets.
  for (const item of remotePack.items) {
    await downloadAndVerifyAsset(canonicalOrigin, item.assetId);
  }
  if (remotePack.coverAssetId) {
    await downloadAndVerifyAsset(canonicalOrigin, remotePack.coverAssetId);
  }

  // 5. Stage in local DB; local admin must approve before serving locally.
  const now = Date.now();
  const replicaId = existingReplica ? existingReplica.id : randomUUID();
  let resultingStatus = 'pending_review';

  if (!existingReplica) {
    db.insert(schema.stickerPacks).values({
      id: replicaId,
      name: remotePack.name,
      description: remotePack.description,
      creatorId: null,
      creatorName: remotePack.creatorName,
      coverAssetId: remotePack.coverAssetId,
      originType: 'replica',
      sourceInstance: canonicalOrigin,
      sourcePackId,
      currentVersion: remotePack.currentVersion,
      status: 'pending_review',
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    upsertPendingReplicaVersion({ replicaId, remotePack, now });
  } else if (existingReplica.status === 'approved') {
    resultingStatus = 'approved';
    if (remotePack.currentVersion > existingReplica.currentVersion) {
      // Keep the already-approved version live while staging the new remote version for local review.
      db.update(schema.stickerPacks).set({
        syncedAt: now,
        updatedAt: now,
      }).where(eq(schema.stickerPacks.id, replicaId)).run();
      upsertPendingReplicaVersion({ replicaId, remotePack, now });
    } else {
      db.update(schema.stickerPacks).set({
        syncedAt: now,
      }).where(eq(schema.stickerPacks.id, replicaId)).run();
    }
  } else {
    db.update(schema.stickerPacks).set({
      name: remotePack.name,
      description: remotePack.description,
      creatorName: remotePack.creatorName,
      coverAssetId: remotePack.coverAssetId,
      currentVersion: remotePack.currentVersion,
      status: 'pending_review',
      reviewNotes: null,
      syncedAt: now,
      updatedAt: now,
    }).where(eq(schema.stickerPacks.id, replicaId)).run();
    upsertPendingReplicaVersion({ replicaId, remotePack, now });
  }

  return { packId: sourcePackId, replicaId, itemCount: remotePack.items.length, status: resultingStatus };
}

/**
 * Reconciles replicated sticker packs from `peerOrigin` against the authoritative
 * peer's current approved pack list and local peer policy:
 * - Disallowed/blocked peers or revoked/rejected peerings immediately stop serving
 *   replicated packs and clean up unreferenced assets.
 * - Packs removed (or unapproved) at the authoritative peer transition to `deleted`
 *   locally and clean up assets with no other references.
 * - Newer remote versions (and new remote packs when `autoSync` is enabled) stage
 *   into `pending_review` for local admin approval.
 */
export async function reconcilePeerStickerPacks(peerOrigin: string): Promise<ReconcilePeerStickersResult> {
  const db = getDb();

  const localReplicas = db.select().from(schema.stickerPacks)
    .where(and(
      eq(schema.stickerPacks.originType, 'replica'),
      eq(schema.stickerPacks.sourceInstance, peerOrigin),
      ne(schema.stickerPacks.status, 'deleted'),
    ))
    .all();

  if (!isStickerPeerAllowed(peerOrigin)) {
    const toBlock = localReplicas.filter(r => r.status !== 'blocked').map(r => r.id);
    const cleanup = purgeStickerPacksAssetsAndData(toBlock, 'blocked');
    return {
      peerOrigin,
      removedPackIds: toBlock,
      syncedPackIds: [],
      cleanedFiles: cleanup.deletedFiles,
      freedBytes: cleanup.freedBytes,
    };
  }

  const peer = db.select().from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, peerOrigin))
    .get();

  if (!peer || peer.status !== 'active') {
    if (peer && (peer.status === 'revoked' || peer.status === 'rejected')) {
      const toBlock = localReplicas.filter(r => r.status !== 'blocked').map(r => r.id);
      const cleanup = purgeStickerPacksAssetsAndData(toBlock, 'blocked');
      return {
        peerOrigin,
        removedPackIds: toBlock,
        syncedPackIds: [],
        cleanedFiles: cleanup.deletedFiles,
        freedBytes: cleanup.freedBytes,
      };
    }
    return { peerOrigin, removedPackIds: [], syncedPackIds: [], cleanedFiles: 0, freedBytes: 0 };
  }

  const canonicalOrigin = peer.origin;
  await assertPeerOriginAllowed(canonicalOrigin, 'approved');

  const body = JSON.stringify({});
  const headers = buildFederationHeaders(body, peer.hmacSecret, getOurOrigin());
  const response = await federationFetch(
    canonicalOrigin,
    '/api/federation/stickers/packs/list',
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    },
    'approved',
  );

  if (!response.ok) {
    throw new Error(`Peer ${canonicalOrigin} returned ${response.status} during sticker pack reconciliation`);
  }

  const payload = (await response.json()) as { packs?: RemotePackListSummary[] };
  if (!payload || !Array.isArray(payload.packs)) {
    throw new Error(`Malformed sticker pack list from ${canonicalOrigin}`);
  }

  const remoteById = new Map(payload.packs.map(p => [p.id, p]));
  const removedReplicaIds: string[] = [];
  for (const replica of localReplicas) {
    if (!replica.sourcePackId || !remoteById.has(replica.sourcePackId)) {
      if (replica.status !== 'blocked') {
        removedReplicaIds.push(replica.id);
      }
    }
  }

  const cleanup = purgeStickerPacksAssetsAndData(removedReplicaIds, 'deleted');
  const syncedPackIds: string[] = [];

  for (const replica of localReplicas) {
    if (replica.status === 'blocked' || !replica.sourcePackId) continue;
    const remote = remoteById.get(replica.sourcePackId);
    if (!remote) continue;
    if (remote.currentVersion > replica.currentVersion) {
      await syncRemotePack({ peerOrigin: canonicalOrigin, packId: replica.sourcePackId });
      syncedPackIds.push(replica.sourcePackId);
    }
  }

  const policyRow = db.select().from(schema.stickerPeerPolicies)
    .where(eq(schema.stickerPeerPolicies.peerOrigin, canonicalOrigin))
    .get();
  if (policyRow?.autoSync === 1) {
    const knownSourceIds = new Set(
      db.select({ sourcePackId: schema.stickerPacks.sourcePackId })
        .from(schema.stickerPacks)
        .where(and(
          eq(schema.stickerPacks.originType, 'replica'),
          eq(schema.stickerPacks.sourceInstance, canonicalOrigin),
        ))
        .all()
        .map(r => r.sourcePackId)
        .filter((v): v is string => Boolean(v)),
    );
    for (const remote of payload.packs) {
      if (!knownSourceIds.has(remote.id)) {
        await syncRemotePack({ peerOrigin: canonicalOrigin, packId: remote.id });
        syncedPackIds.push(remote.id);
      }
    }
  }

  return {
    peerOrigin: canonicalOrigin,
    removedPackIds: removedReplicaIds,
    syncedPackIds,
    cleanedFiles: cleanup.deletedFiles,
    freedBytes: cleanup.freedBytes,
  };
}

/**
 * Reconciles every peer that either is allowed to supply stickers or still holds
 * non-deleted local sticker replicas.
 */
export async function reconcileAllStickerPeers(): Promise<ReconcilePeerStickersResult[]> {
  const db = getDb();
  const origins = new Set<string>();

  for (const row of db.select({ peerOrigin: schema.stickerPeerPolicies.peerOrigin })
    .from(schema.stickerPeerPolicies)
    .where(eq(schema.stickerPeerPolicies.policy, 'allow'))
    .all()) {
    origins.add(row.peerOrigin);
  }
  for (const row of db.select({ sourceInstance: schema.stickerPacks.sourceInstance })
    .from(schema.stickerPacks)
    .where(and(
      eq(schema.stickerPacks.originType, 'replica'),
      ne(schema.stickerPacks.status, 'deleted'),
    ))
    .all()) {
    if (row.sourceInstance) origins.add(row.sourceInstance);
  }

  const results: ReconcilePeerStickersResult[] = [];
  for (const origin of origins) {
    try {
      results.push(await reconcilePeerStickerPacks(origin));
    } catch (err) {
      console.warn(`[sticker-sync] Reconciliation failed for ${origin}: ${(err as Error).message}`);
    }
  }
  return results;
}
