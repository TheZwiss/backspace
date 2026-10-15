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
import { registerStickerFederationRoutes } from './federation/handlers/stickerSync.js';
import { syncRemotePack } from '../utils/stickerSync.js';

const settings = vi.hoisted(() => ({ uploadDir: '' }));
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
  settings.uploadDir = await mkdtemp(path.join(tmpdir(), 'backspace-sticker-store-'));
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
});

