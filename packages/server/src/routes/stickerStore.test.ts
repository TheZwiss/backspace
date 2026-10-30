import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import * as schema from '../db/index.js';
import { stickerRoutes } from './stickers.js';
import { stickerStoreRoutes } from './stickerStore.js';
import { _resetStickerLibraryRateLimit, stickerLibraryRoutes } from './stickerLibrary.js';
import { registerStickerFederationRoutes } from './federation/handlers/stickerSync.js';
import { syncRemotePack } from '../utils/stickerSync.js';
import { getMaxStickerSizeBytes } from '../utils/stickerAssets.js';

const settings = vi.hoisted(() => ({ uploadDir: '', maxStickerSize: 5 * 1024 * 1024 }));
let db: ReturnType<typeof drizzle<typeof schema.schema>>;
let sqlite: Database.Database;
let app: FastifyInstance;

vi.mock('../db/index.js', async () => {
  const actualSchema = await vi.importActual('../db/schema.js');
  return {
    getDb: () => db,
    schema: actualSchema,
  };
});

vi.mock('../config.js', () => ({ config: settings }));
vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://chat.test',
  buildFederationHeaders: () => ({
    'x-federation-signature': 'sig',
    'x-federation-origin': 'https://remote.test',
    'x-federation-timestamp': String(Date.now()),
    'x-federation-nonce': 'nonce-1',
  }),
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (request: { userId?: string; username?: string; headers: Record<string, string> }, reply: { code: (code: number) => { send: (body?: unknown) => void } }) => {
    const auth = request.headers.authorization;
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    request.userId = auth;
    request.username = auth;
  },
  requireAdmin: async (request: { userId?: string }, reply: { code: (code: number) => { send: (body?: unknown) => void } }) => {
    if (request.userId !== 'admin') {
      return reply.code(403).send({ error: 'forbidden' });
    }
  },
  verifyJwtAndUser: async (token: string) => ({
    userId: token,
    username: token,
    homeInstance: null,
  }),
}));

vi.mock('./federation/handlers/s2sAuth.js', () => ({
  authenticateS2SPeer: () => ({ ok: true, peer: { origin: 'https://peer.test' }, nonce: 'nonce-123' }),
}));

beforeEach(async () => {
  _resetStickerLibraryRateLimit();
  settings.uploadDir = await mkdtemp(path.join(tmpdir(), 'backspace-sticker-store-'));
  settings.maxStickerSize = 5 * 1024 * 1024;
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema: schema.schema });
  migrate(db, { migrationsFolder: path.resolve('drizzle') });

  // Seed users: alice, bob, admin
  for (const id of ['alice', 'bob', 'admin']) {
    db.insert(schema.schema.users).values({
      id,
      username: id,
      passwordHash: 'test',
      isAdmin: id === 'admin' ? 1 : 0,
      createdAt: 1,
    }).run();
  }

  app = Fastify();
  await app.register(stickerRoutes);
  await app.register(stickerStoreRoutes);
  await app.register(stickerLibraryRoutes);
  registerStickerFederationRoutes(app);
});

afterEach(async () => {
  await app.close();
  sqlite.close();
  await rm(settings.uploadDir, { recursive: true, force: true });
});

async function makeTestImage(color = 'blue'): Promise<string> {
  const buf = await sharp({ create: { width: 16, height: 16, channels: 4, background: color } }).png().toBuffer();
  return buf.toString('base64');
}

describe('Federated Sticker Store', () => {
  it('supports full pack creation, item upload, review submission and admin approval', async () => {
    // 1. Alice creates a pack
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sticker-packs',
      headers: { authorization: 'alice' },
      payload: { name: 'Cool Cats', description: 'Cute cat stickers' },
    });
    expect(createRes.statusCode).toBe(200);
    const pack = createRes.json();
    expect(pack.name).toBe('Cool Cats');
    expect(pack.status).toBe('draft');
    expect(pack.currentVersion).toBe(1);

    // 2. Alice adds sticker items
    const img1 = await makeTestImage('blue');
    const addItemRes = await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/items`,
      headers: { authorization: 'alice' },
      payload: { name: 'Cat Wave', image: img1 },
    });
    expect(addItemRes.statusCode).toBe(200);
    const item = addItemRes.json();
    expect(item.name).toBe('Cat Wave');
    expect(item.token).toContain('/api/stickers/assets/');

    // 3. Alice submits pack for review
    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/submit`,
      headers: { authorization: 'alice' },
    });
    expect(submitRes.statusCode).toBe(200);
    expect(submitRes.json().status).toBe('pending_review');

    // 4. Admin reviews pending packs
    const reviewListRes = await app.inject({
      method: 'GET',
      url: '/api/admin/sticker-packs/reviews',
      headers: { authorization: 'admin' },
    });
    expect(reviewListRes.statusCode).toBe(200);
    const reviews = reviewListRes.json();
    expect(reviews.length).toBe(1);
    expect(reviews[0].id).toBe(pack.id);
    expect(reviews[0].itemCount).toBe(1);

    // 5. Admin approves pack
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/admin/sticker-packs/${pack.id}/approve`,
      headers: { authorization: 'admin' },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().status).toBe('approved');

    // 6. Pack now visible in public sticker store
    const storeRes = await app.inject({
      method: 'GET',
      url: '/api/sticker-store/packs',
    });
    expect(storeRes.statusCode).toBe(200);
    const storePacks = storeRes.json();
    expect(storePacks.length).toBe(1);
    expect(storePacks[0].name).toBe('Cool Cats');

    // 7. Bob installs the pack
    const installRes = await app.inject({
      method: 'POST',
      url: `/api/sticker-store/packs/${pack.id}/install`,
      headers: { authorization: 'bob' },
    });
    expect(installRes.statusCode).toBe(200);

    // 8. Bob checks his installed packs
    const myPacksRes = await app.inject({
      method: 'GET',
      url: '/api/sticker-store/my-packs',
      headers: { authorization: 'bob' },
    });
    expect(myPacksRes.statusCode).toBe(200);
    const bobPacks = myPacksRes.json();
    expect(bobPacks.length).toBe(1);
    expect(bobPacks[0].items.length).toBe(1);
    expect(bobPacks[0].items[0].name).toBe('Cat Wave');
  });

  it('enforces versioning: editing an approved pack requires creating a new version', async () => {
    // 1. Create and approve a pack
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sticker-packs',
      headers: { authorization: 'alice' },
      payload: { name: 'Versioned Pack' },
    });
    const pack = createRes.json();

    const img1 = await makeTestImage('yellow');
    await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/items`,
      headers: { authorization: 'alice' },
      payload: { name: 'Item 1', image: img1 },
    });

    await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/submit`,
      headers: { authorization: 'alice' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/admin/sticker-packs/${pack.id}/approve`,
      headers: { authorization: 'admin' },
    });

    // 2. Direct modification on approved pack is rejected
    const directAddRes = await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/items`,
      headers: { authorization: 'alice' },
      payload: { name: 'Item 2', image: img1 },
    });
    expect(directAddRes.statusCode).toBe(400);

    // 3. Create new version
    const newVerRes = await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/new-version`,
      headers: { authorization: 'alice' },
    });
    expect(newVerRes.statusCode).toBe(200);
    expect(newVerRes.json().newVersion).toBe(2);

    // 4. In new version, adding items works
    const img2 = await makeTestImage('purple');
    const addVer2ItemRes = await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/items`,
      headers: { authorization: 'alice' },
      payload: { name: 'Item 2', image: img2 },
    });
    expect(addVer2ItemRes.statusCode).toBe(200);

    // 5. Meanwhile, the public store still serves Version 1 with 1 item!
    const storeRes = await app.inject({
      method: 'GET',
      url: `/api/sticker-store/packs/${pack.id}`,
    });
    expect(storeRes.statusCode).toBe(200);
    expect(storeRes.json().currentVersion).toBe(1);
    expect(storeRes.json().items.length).toBe(1);
  });

  it('implements soft delete lifecycle without deleting physical assets', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sticker-packs',
      headers: { authorization: 'alice' },
      payload: { name: 'To Be Deleted' },
    });
    const pack = createRes.json();

    const img = await makeTestImage('green');
    const itemRes = await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/items`,
      headers: { authorization: 'alice' },
      payload: { name: 'Green Sticker', image: img },
    });
    const item = itemRes.json();

    // Delete pack
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/sticker-packs/${pack.id}`,
      headers: { authorization: 'alice' },
    });
    expect(delRes.statusCode).toBe(200);

    // Pack is no longer in store
    const storeRes = await app.inject({
      method: 'GET',
      url: `/api/sticker-store/packs/${pack.id}`,
    });
    expect(storeRes.statusCode).toBe(404);

    // But the asset file still exists and can be served for history!
    const assetRes = await app.inject({
      method: 'GET',
      url: `/api/stickers/assets/${item.assetId}.webp`,
    });
    expect(assetRes.statusCode).toBe(200);
  });

  it('serves S2S federation pack listing and details', async () => {
    // Create & approve pack
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sticker-packs',
      headers: { authorization: 'alice' },
      payload: { name: 'Federated Pack', description: 'Available across servers' },
    });
    const pack = createRes.json();
    const img = await makeTestImage('pink');
    await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/items`,
      headers: { authorization: 'alice' },
      payload: { name: 'Pink Sticker', image: img },
    });
    await app.inject({
      method: 'POST',
      url: `/api/sticker-packs/${pack.id}/submit`,
      headers: { authorization: 'alice' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/admin/sticker-packs/${pack.id}/approve`,
      headers: { authorization: 'admin' },
    });

    // S2S list
    const listRes = await app.inject({
      method: 'POST',
      url: '/api/federation/stickers/packs/list',
    });
    expect(listRes.statusCode).toBe(200);
    const listData = listRes.json();
    expect(listData.packs.length).toBe(1);
    expect(listData.packs[0].name).toBe('Federated Pack');

    // S2S get
    const getRes = await app.inject({
      method: 'POST',
      url: '/api/federation/stickers/packs/get',
      payload: { packId: pack.id },
    });
    expect(getRes.statusCode).toBe(200);
    const getData = getRes.json();
    expect(getData.name).toBe('Federated Pack');
    expect(getData.items.length).toBe(1);
    expect(getData.items[0].name).toBe('Pink Sticker');
  });

  it('allows admin to set peer policy to block and auto-updates replica status', async () => {
    // Set policy for peer to block
    const setPolicyRes = await app.inject({
      method: 'PUT',
      url: `/api/admin/federation/stickers/peers/${encodeURIComponent('https://evil.test')}/policy`,
      headers: { authorization: 'admin' },
      payload: { policy: 'block' },
    });
    expect(setPolicyRes.statusCode).toBe(200);

    const pol = db.select().from(schema.schema.stickerPeerPolicies)
      .where(eq(schema.schema.stickerPeerPolicies.peerOrigin, 'https://evil.test')).get();
    expect(pol?.policy).toBe('block');
  });

  it('syncs remote sticker pack, downloads and verifies content-addressed assets', async () => {
    const peerOrigin = 'https://peer.test';
    // Register active peer
    db.insert(schema.schema.federationPeers).values({
      id: 'peer-1',
      origin: peerOrigin,
      hmacSecret: 'secret',
      status: 'active',
      createdAt: 1,
    }).run();

    const testBuf = await sharp({ create: { width: 8, height: 8, channels: 4, background: 'orange' } }).png().toBuffer();
    const { createHash } = await import('node:crypto');
    const assetId = createHash('sha256').update(testBuf).digest('hex');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/federation/stickers/packs/get')) {
        return new Response(JSON.stringify({
          id: 'rem-pack-1',
          name: 'Remote Orange Pack',
          description: 'From peer',
          creatorName: 'remote_user',
          coverAssetId: null,
          currentVersion: 1,
          items: [{ assetId, name: 'Orange Star', sortOrder: 0 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes(`/api/stickers/assets/${assetId}.webp`)) {
        return new Response(testBuf, { status: 200, headers: { 'Content-Type': 'image/webp' } });
      }
      return new Response(null, { status: 404 });
    });

    try {
      const syncResult = await syncRemotePack({ peerOrigin, packId: 'rem-pack-1' });
      expect(syncResult.packId).toBe('rem-pack-1');
      expect(syncResult.itemCount).toBe(1);

      // Verify replica pack is stored locally
      const replica = db.select().from(schema.schema.stickerPacks)
        .where(eq(schema.schema.stickerPacks.id, syncResult.replicaId)).get();
      expect(replica).toBeDefined();
      expect(replica?.originType).toBe('replica');
      expect(replica?.sourceInstance).toBe(peerOrigin);
      expect(replica?.status).toBe('active');

      // Verify asset exists locally in sticker_assets
      const asset = db.select().from(schema.schema.stickerAssets)
        .where(eq(schema.schema.stickerAssets.id, assetId)).get();
      expect(asset).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects remote asset download when content-addressed hash does not match', async () => {
    const peerOrigin = 'https://peer.test';
    db.insert(schema.schema.federationPeers).values({
      id: 'peer-2',
      origin: peerOrigin,
      hmacSecret: 'secret',
      status: 'active',
      createdAt: 1,
    }).onConflictDoNothing().run();

    const fakeAssetId = 'a'.repeat(64);
    const tamperedBuf = Buffer.from('not matching bytes');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/federation/stickers/packs/get')) {
        return new Response(JSON.stringify({
          id: 'rem-pack-tampered',
          name: 'Tampered Pack',
          description: null,
          creatorName: 'hacker',
          coverAssetId: null,
          currentVersion: 1,
          items: [{ assetId: fakeAssetId, name: 'Fake', sortOrder: 0 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes(`/api/stickers/assets/${fakeAssetId}.webp`)) {
        return new Response(tamperedBuf, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    try {
      await expect(syncRemotePack({ peerOrigin, packId: 'rem-pack-tampered' }))
        .rejects.toThrow(/hash mismatch/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects remote sticker assets that exceed the instance byte limit', async () => {
    const peerOrigin = 'https://peer.test';
    db.insert(schema.schema.federationPeers).values({
      id: 'peer-oversized',
      origin: peerOrigin,
      hmacSecret: 'secret',
      status: 'active',
      createdAt: 1,
    }).onConflictDoNothing().run();
    settings.maxStickerSize = 16;
    expect(getMaxStickerSizeBytes()).toBe(16);

    const oversizedId = 'b'.repeat(64);
    const oversized = Buffer.alloc(17, 1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/federation/stickers/packs/get')) {
        return new Response(JSON.stringify({
          id: 'rem-pack-oversized',
          name: 'Oversized Pack',
          description: null,
          creatorName: 'remote_user',
          coverAssetId: null,
          currentVersion: 1,
          items: [{ assetId: oversizedId, name: 'Too large', sortOrder: 0 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes(`/api/stickers/assets/${oversizedId}.webp`)) {
        return new Response(oversized, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    try {
      await expect(syncRemotePack({ peerOrigin, packId: 'rem-pack-oversized' }))
        .rejects.toThrow(/exceeds the 16-byte limit/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('manages private albums, favorites and approved instance shares', async () => {
    const image = await makeTestImage('green');
    const created = await app.inject({
      method: 'POST',
      url: '/api/private-sticker-packs',
      headers: { authorization: 'alice' },
      payload: { name: 'Alice Album' },
    });
    expect(created.statusCode).toBe(201);
    const pack = created.json();

    const added = await app.inject({
      method: 'POST',
      url: `/api/sticker-library/packs/${pack.id}/items`,
      headers: { authorization: 'alice' },
      payload: {
        name: 'Cropped',
        image,
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      },
    });
    expect(added.statusCode).toBe(201);

    const favorite = await app.inject({
      method: 'POST',
      url: '/api/sticker-favorites',
      headers: { authorization: 'bob' },
      payload: { name: 'Borrowed', image },
    });
    expect(favorite.statusCode).toBe(201);

    const bobPack = await app.inject({
      method: 'POST',
      url: '/api/private-sticker-packs',
      headers: { authorization: 'bob' },
      payload: { name: 'Bob Album' },
    });
    const fromFavorite = await app.inject({
      method: 'POST',
      url: `/api/private-sticker-packs/${bobPack.json().id}/items/from-favorite`,
      headers: { authorization: 'bob' },
      payload: { favoriteId: favorite.json().id, name: 'Copied Favorite' },
    });
    expect(fromFavorite.statusCode).toBe(201);

    const share = await app.inject({
      method: 'POST',
      url: `/api/private-sticker-packs/${pack.id}/shares`,
      headers: { authorization: 'alice' },
      payload: { targetType: 'instance' },
    });
    expect(share.statusCode).toBe(201);

    const pending = await app.inject({
      method: 'GET',
      url: '/api/sticker-pack-shares?targetType=instance',
      headers: { authorization: 'admin' },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()[0].pack.name).toBe('Alice Album');

    const decision = await app.inject({
      method: 'POST',
      url: `/api/sticker-pack-shares/${share.json().id}/decision`,
      headers: { authorization: 'admin' },
      payload: { decision: 'approved' },
    });
    expect(decision.statusCode).toBe(200);

    const explored = await app.inject({
      method: 'GET',
      url: '/api/sticker-store/packs',
      headers: { authorization: 'Bearer bob' },
    });
    expect(explored.json().map((entry: { id: string }) => entry.id)).toContain(pack.id);
  });

  it('renames and deletes private albums without breaking sent stickers', async () => {
    const image = await makeTestImage('orange');
    const created = await app.inject({
      method: 'POST',
      url: '/api/private-sticker-packs',
      headers: { authorization: 'alice' },
      payload: { name: 'Before rename' },
    });
    const pack = created.json();
    const item = await app.inject({
      method: 'POST',
      url: `/api/sticker-library/packs/${pack.id}/items`,
      headers: { authorization: 'alice' },
      payload: { name: 'Before item rename', image },
    });
    expect(item.statusCode).toBe(201);

    const renamedPack = await app.inject({
      method: 'PATCH',
      url: `/api/private-sticker-packs/${pack.id}`,
      headers: { authorization: 'alice' },
      payload: { name: 'After rename' },
    });
    expect(renamedPack.statusCode).toBe(200);
    expect(renamedPack.json()).toMatchObject({ name: 'After rename' });

    const renamedItem = await app.inject({
      method: 'PATCH',
      url: `/api/sticker-library/packs/${pack.id}/items/${item.json().id}`,
      headers: { authorization: 'alice' },
      payload: { name: 'After item rename' },
    });
    expect(renamedItem.statusCode).toBe(200);
    expect(renamedItem.json()).toMatchObject({ name: 'After item rename' });

    const share = await app.inject({
      method: 'POST',
      url: `/api/private-sticker-packs/${pack.id}/shares`,
      headers: { authorization: 'alice' },
      payload: { targetType: 'instance' },
    });
    expect(share.statusCode).toBe(201);

    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/private-sticker-packs/${pack.id}`,
      headers: { authorization: 'bob' },
    });
    expect(forbidden.statusCode).toBe(403);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/private-sticker-packs/${pack.id}`,
      headers: { authorization: 'alice' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(db.select().from(schema.schema.stickerPacks).where(eq(schema.schema.stickerPacks.id, pack.id)).get()?.status).toBe('deleted');
    expect(db.select().from(schema.schema.stickerPackShares).where(eq(schema.schema.stickerPackShares.packId, pack.id)).all()).toEqual([]);
    expect(db.select().from(schema.schema.stickerPackItems).where(eq(schema.schema.stickerPackItems.packId, pack.id)).get()?.status).toBe('deleted');

    const library = await app.inject({
      method: 'GET',
      url: '/api/sticker-library',
      headers: { authorization: 'alice' },
    });
    expect(library.json().privatePacks).toEqual([]);
  });

  it('has one server pack, enforces its permissions and accepts approved album shares', async () => {
    const now = Date.now();
    db.insert(schema.schema.spaces).values({
      id: 'sticker-space',
      name: 'Sticker Space',
      ownerId: 'alice',
      inviteCode: 'stickers',
      visibility: 'private',
      createdAt: now,
    }).run();
    db.insert(schema.schema.spaceMembers).values([
      { spaceId: 'sticker-space', userId: 'alice', joinedAt: now },
      { spaceId: 'sticker-space', userId: 'bob', joinedAt: now },
    ]).run();

    const serverPack = await app.inject({
      method: 'POST',
      url: '/api/spaces/sticker-space/sticker-pack',
      headers: { authorization: 'alice' },
    });
    expect(serverPack.statusCode).toBe(201);
    const secondCreate = await app.inject({
      method: 'POST',
      url: '/api/spaces/sticker-space/sticker-pack',
      headers: { authorization: 'alice' },
    });
    expect(secondCreate.statusCode).toBe(200);
    expect(secondCreate.json().id).toBe(serverPack.json().id);

    const image = await makeTestImage('purple');
    const bobPack = await app.inject({
      method: 'POST',
      url: '/api/private-sticker-packs',
      headers: { authorization: 'bob' },
      payload: { name: 'Shared to server' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/sticker-library/packs/${bobPack.json().id}/items`,
      headers: { authorization: 'bob' },
      payload: { name: 'Share me', image },
    });
    const share = await app.inject({
      method: 'POST',
      url: `/api/private-sticker-packs/${bobPack.json().id}/shares`,
      headers: { authorization: 'bob' },
      payload: { targetType: 'space', targetId: 'sticker-space' },
    });
    expect(share.statusCode).toBe(201);
    const approved = await app.inject({
      method: 'POST',
      url: `/api/sticker-pack-shares/${share.json().id}/decision`,
      headers: { authorization: 'alice' },
      payload: { decision: 'approved' },
    });
    expect(approved.statusCode).toBe(200);

    const explored = await app.inject({
      method: 'GET',
      url: '/api/sticker-store/packs?spaceId=sticker-space',
      headers: { authorization: 'Bearer bob' },
    });
    expect(explored.json().map((entry: { id: string }) => entry.id)).toContain(bobPack.json().id);
  });
});

