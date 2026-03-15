import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { hasPermission, PermissionBits, isMember } from '../utils/permissions.js';
import { connectionManager } from '../ws/handler.js';
import { config } from '../config.js';
import type { Sticker, StickerPack } from '@backspace/shared';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const MAX_STICKER_SIZE = 500 * 1024; // 500KB
const MAX_STICKER_DIMENSION = 512;
const ALLOWED_STICKER_TYPES = ['image/png', 'image/webp', 'image/gif'];

function getSpaceIdForPack(packId: string): string | null {
  const db = getDb();
  const pack = db.select({ spaceId: schema.stickerPacks.spaceId })
    .from(schema.stickerPacks)
    .where(eq(schema.stickerPacks.id, packId))
    .get();
  return pack?.spaceId ?? null;
}

function getStickerSpaceId(stickerId: string): string | null {
  const db = getDb();
  const sticker = db.select({ spaceId: schema.stickers.spaceId })
    .from(schema.stickers)
    .where(eq(schema.stickers.id, stickerId))
    .get();
  return sticker?.spaceId ?? null;
}

function packToResponse(pack: typeof schema.stickerPacks.$inferSelect, stickerRows: (typeof schema.stickers.$inferSelect)[]): StickerPack {
  return {
    id: pack.id,
    spaceId: pack.spaceId,
    name: pack.name,
    description: pack.description,
    createdBy: pack.createdBy,
    createdAt: pack.createdAt,
    stickers: stickerRows.map(stickerToResponse),
  };
}

function stickerToResponse(s: typeof schema.stickers.$inferSelect): Sticker {
  return {
    id: s.id,
    packId: s.packId,
    spaceId: s.spaceId,
    name: s.name,
    tags: s.tags ?? '',
    filename: s.filename,
    mimetype: s.mimetype,
    size: s.size,
    width: s.width,
    height: s.height,
    uploadedBy: s.uploadedBy,
    createdAt: s.createdAt,
  };
}

export async function stickerRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/spaces/:id/sticker-packs — list all packs in a space
  app.get<{ Params: { id: string } }>('/api/spaces/:id/sticker-packs', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const spaceId = request.params.id;
    if (!isMember(spaceId, request.userId)) {
      return reply.code(403).send({ error: 'Not a member of this space', statusCode: 403 });
    }

    const db = getDb();
    const packs = db.select().from(schema.stickerPacks)
      .where(eq(schema.stickerPacks.spaceId, spaceId))
      .all();

    const packIds = packs.map(p => p.id);
    const allStickers = packIds.length > 0
      ? db.select().from(schema.stickers).where(inArray(schema.stickers.packId, packIds)).all()
      : [];

    const stickersByPack = new Map<string, (typeof schema.stickers.$inferSelect)[]>();
    for (const s of allStickers) {
      const arr = stickersByPack.get(s.packId) ?? [];
      arr.push(s);
      stickersByPack.set(s.packId, arr);
    }

    return reply.code(200).send({
      packs: packs.map(p => packToResponse(p, stickersByPack.get(p.id) ?? [])),
    });
  });

  // POST /api/spaces/:id/sticker-packs — create a pack
  app.post<{ Params: { id: string }; Body: { name: string; description?: string } }>('/api/spaces/:id/sticker-packs', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const spaceId = request.params.id;
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SPACE permission', statusCode: 403 });
    }

    const { name, description } = request.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 32) {
      return reply.code(400).send({ error: 'Pack name must be 1-32 characters', statusCode: 400 });
    }

    const db = getDb();
    const packId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.stickerPacks).values({
      id: packId,
      spaceId,
      name: name.trim(),
      description: description?.trim() || null,
      createdBy: request.userId,
      createdAt: now,
    }).run();

    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, packId)).get()!;
    const response = packToResponse(pack, []);

    connectionManager.sendToSpace(spaceId, {
      type: 'sticker_pack_created',
      spaceId,
      pack: response,
    });

    return reply.code(201).send(response);
  });

  // PATCH /api/spaces/:id/sticker-packs/:packId — update a pack
  app.patch<{ Params: { id: string; packId: string }; Body: { name?: string; description?: string } }>('/api/spaces/:id/sticker-packs/:packId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id: spaceId, packId } = request.params;
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SPACE permission', statusCode: 403 });
    }

    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(
      and(eq(schema.stickerPacks.id, packId), eq(schema.stickerPacks.spaceId, spaceId))
    ).get();
    if (!pack) {
      return reply.code(404).send({ error: 'Pack not found', statusCode: 404 });
    }

    const updates: Record<string, string | null> = {};
    if (request.body.name !== undefined) {
      if (typeof request.body.name !== 'string' || request.body.name.trim().length === 0 || request.body.name.trim().length > 32) {
        return reply.code(400).send({ error: 'Pack name must be 1-32 characters', statusCode: 400 });
      }
      updates.name = request.body.name.trim();
    }
    if (request.body.description !== undefined) {
      updates.description = request.body.description?.trim() || null;
    }

    if (Object.keys(updates).length > 0) {
      db.update(schema.stickerPacks).set(updates).where(eq(schema.stickerPacks.id, packId)).run();
    }

    const updatedPack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, packId)).get()!;
    const stickers = db.select().from(schema.stickers).where(eq(schema.stickers.packId, packId)).all();
    const response = packToResponse(updatedPack, stickers);

    connectionManager.sendToSpace(spaceId, {
      type: 'sticker_pack_updated',
      spaceId,
      pack: response,
    });

    return reply.code(200).send(response);
  });

  // DELETE /api/spaces/:id/sticker-packs/:packId — delete a pack (cascades stickers)
  app.delete<{ Params: { id: string; packId: string } }>('/api/spaces/:id/sticker-packs/:packId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id: spaceId, packId } = request.params;
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SPACE permission', statusCode: 403 });
    }

    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(
      and(eq(schema.stickerPacks.id, packId), eq(schema.stickerPacks.spaceId, spaceId))
    ).get();
    if (!pack) {
      return reply.code(404).send({ error: 'Pack not found', statusCode: 404 });
    }

    // Get sticker files to clean up
    const stickers = db.select().from(schema.stickers).where(eq(schema.stickers.packId, packId)).all();

    // Delete pack (cascade deletes stickers)
    db.delete(schema.stickerPacks).where(eq(schema.stickerPacks.id, packId)).run();

    // Clean up files
    for (const s of stickers) {
      const filePath = path.join(config.uploadDir, path.basename(s.filename));
      try { fs.unlinkSync(filePath); } catch {}
    }

    connectionManager.sendToSpace(spaceId, {
      type: 'sticker_pack_deleted',
      spaceId,
      packId,
    });

    return reply.code(200).send({ success: true });
  });

  // POST /api/spaces/:id/sticker-packs/:packId/stickers — upload a sticker
  app.post<{ Params: { id: string; packId: string } }>('/api/spaces/:id/sticker-packs/:packId/stickers', {
    preHandler: authenticate,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.userId || request.ip,
      },
    },
  }, async (request, reply) => {
    const { id: spaceId, packId } = request.params;
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SPACE permission', statusCode: 403 });
    }

    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(
      and(eq(schema.stickerPacks.id, packId), eq(schema.stickerPacks.spaceId, spaceId))
    ).get();
    if (!pack) {
      return reply.code(404).send({ error: 'Pack not found', statusCode: 404 });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded', statusCode: 400 });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length > MAX_STICKER_SIZE) {
      return reply.code(400).send({ error: 'Sticker must be 500KB or less', statusCode: 400 });
    }

    if (!ALLOWED_STICKER_TYPES.includes(data.mimetype)) {
      return reply.code(400).send({ error: 'Sticker must be PNG, WebP, or GIF', statusCode: 400 });
    }

    // Read name and tags from multipart fields
    const fields = data.fields as Record<string, any>;
    const name = (fields.name?.value || 'sticker').toString().trim().slice(0, 32);
    const tags = (fields.tags?.value || '').toString().trim().slice(0, 100);

    // Read dimensions with sharp, auto-downscale if oversized
    let width: number | null = null;
    let height: number | null = null;
    let finalBuffer = buffer;
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(buffer).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;

      if ((width && width > MAX_STICKER_DIMENSION) || (height && height > MAX_STICKER_DIMENSION)) {
        // Auto-downscale to fit within 512x512, preserving aspect ratio and GIF animation
        const isAnimated = data.mimetype === 'image/gif';
        const resized = sharp(buffer, isAnimated ? { animated: true } : undefined)
          .resize({ width: MAX_STICKER_DIMENSION, height: MAX_STICKER_DIMENSION, fit: 'inside' });
        finalBuffer = Buffer.from(await resized.toBuffer());
        const resizedMeta = await sharp(finalBuffer, isAnimated ? { animated: true } : undefined).metadata();
        width = resizedMeta.width ?? null;
        height = resizedMeta.height ?? null;
        console.log(`[Stickers] Auto-downscaled sticker from ${meta.width}x${meta.height} to ${width}x${height}`);
      }
    } catch {
      // Can't read dimensions — allow anyway
    }

    // Save file
    const ext = data.mimetype === 'image/png' ? '.png' : data.mimetype === 'image/webp' ? '.webp' : '.gif';
    const filename = `sticker_${crypto.randomBytes(16).toString('hex')}${ext}`;
    const filePath = path.join(config.uploadDir, filename);
    fs.writeFileSync(filePath, finalBuffer);

    const stickerId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.stickers).values({
      id: stickerId,
      packId,
      spaceId,
      name,
      tags,
      filename,
      mimetype: data.mimetype,
      size: finalBuffer.length,
      width,
      height,
      uploadedBy: request.userId,
      createdAt: now,
    }).run();

    const sticker = db.select().from(schema.stickers).where(eq(schema.stickers.id, stickerId)).get()!;
    const response = stickerToResponse(sticker);

    connectionManager.sendToSpace(spaceId, {
      type: 'sticker_created',
      spaceId,
      sticker: response,
    });

    return reply.code(201).send(response);
  });

  // DELETE /api/stickers/:id — delete a sticker
  app.delete<{ Params: { id: string } }>('/api/stickers/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const stickerId = request.params.id;
    const spaceId = getStickerSpaceId(stickerId);
    if (!spaceId) {
      return reply.code(404).send({ error: 'Sticker not found', statusCode: 404 });
    }
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SPACE permission', statusCode: 403 });
    }

    const db = getDb();
    const sticker = db.select().from(schema.stickers).where(eq(schema.stickers.id, stickerId)).get();
    if (!sticker) {
      return reply.code(404).send({ error: 'Sticker not found', statusCode: 404 });
    }

    db.delete(schema.stickers).where(eq(schema.stickers.id, stickerId)).run();

    // Clean up file
    const filePath = path.join(config.uploadDir, path.basename(sticker.filename));
    try { fs.unlinkSync(filePath); } catch {}

    connectionManager.sendToSpace(spaceId, {
      type: 'sticker_deleted',
      spaceId,
      stickerId,
    });

    return reply.code(200).send({ success: true });
  });

  // GET /api/users/@me/stickers — all stickers from joined spaces
  app.get('/api/users/@me/stickers', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();

    // Get all spaces the user is a member of
    const memberships = db.select({ spaceId: schema.spaceMembers.spaceId })
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.userId, request.userId))
      .all();

    const spaceIds = memberships.map(m => m.spaceId);
    if (spaceIds.length === 0) {
      return reply.code(200).send({ packs: [] });
    }

    // Get all packs from those spaces
    const packs = db.select().from(schema.stickerPacks)
      .where(inArray(schema.stickerPacks.spaceId, spaceIds))
      .all();

    if (packs.length === 0) {
      return reply.code(200).send({ packs: [] });
    }

    const packIds = packs.map(p => p.id);
    const allStickers = db.select().from(schema.stickers)
      .where(inArray(schema.stickers.packId, packIds))
      .all();

    const stickersByPack = new Map<string, (typeof schema.stickers.$inferSelect)[]>();
    for (const s of allStickers) {
      const arr = stickersByPack.get(s.packId) ?? [];
      arr.push(s);
      stickersByPack.set(s.packId, arr);
    }

    // Get space names for labeling
    const spaceRows = db.select({ id: schema.spaces.id, name: schema.spaces.name })
      .from(schema.spaces)
      .where(inArray(schema.spaces.id, spaceIds))
      .all();
    const spaceNameMap = new Map(spaceRows.map(s => [s.id, s.name]));

    const result: StickerPack[] = packs.map(p => ({
      ...packToResponse(p, stickersByPack.get(p.id) ?? []),
      spaceName: spaceNameMap.get(p.spaceId) ?? 'Unknown',
    }));

    return reply.code(200).send({ packs: result });
  });
}
