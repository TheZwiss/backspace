import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, hasPermission, getChannelSpaceId, PermissionBits, computePermissions } from '../utils/permissions.js';
import { permissionsToString } from '@backspace/shared/src/permissions.js';
import { connectionManager } from '../ws/handler.js';
import { checkVoicePermissions } from '../ws/events.js';
import type {
  CreateChannelRequest,
  UpdateChannelRequest,
  Channel,
  ChannelCategory,
} from '@backspace/shared';

function rowToChannel(row: typeof schema.channels.$inferSelect): Channel {
  return {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    type: row.type as Channel['type'],
    topic: row.topic,
    position: row.position ?? 0,
    categoryId: row.categoryId ?? null,
    createdAt: row.createdAt,
  };
}

function rowToCategory(row: typeof schema.channelCategories.$inferSelect): ChannelCategory {
  return {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    position: row.position ?? 0,
    createdAt: row.createdAt,
  };
}

/**
 * After a channel override changes, notify each space member:
 * - VIEW_CHANNEL holders receive channel_updated (with their myPermissions)
 * - Non-viewers receive channel_deleted to remove the channel from their UI
 */
function broadcastOverrideChange(spaceId: string, channelId: string): void {
  const db = getDb();
  const channel = db.select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
  if (!channel) return;

  const channelData = rowToChannel(channel);

  for (const [userId, spaceIds] of connectionManager.getUserSpaceEntries()) {
    if (!spaceIds.has(spaceId)) continue;

    const perms = computePermissions(userId, spaceId, channelId);
    if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
      connectionManager.sendToUser(userId, {
        type: 'channel_updated',
        channel: { ...channelData, myPermissions: permissionsToString(perms) },
        spaceId,
      });
    } else {
      connectionManager.sendToUser(userId, {
        type: 'channel_deleted',
        channelId,
        spaceId,
      });
    }
  }
}

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/spaces/:id/channels - List channels in a space
  app.get<{ Params: { id: string } }>('/api/spaces/:id/channels', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!space) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!isMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this space', statusCode: 403 });
    }

    const allChannels = db.select()
      .from(schema.channels)
      .where(eq(schema.channels.spaceId, id))
      .all();

    // Filter by VIEW_CHANNEL permission per channel
    const visibleChannels = allChannels.filter(ch => {
      const perms = computePermissions(request.userId, id, ch.id);
      return (perms & PermissionBits.VIEW_CHANNEL) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
    });

    // Sort by position
    visibleChannels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    return reply.code(200).send(visibleChannels.map(rowToChannel));
  });

  // POST /api/spaces/:id/channels - Create a channel (admin+)
  app.post<{ Params: { id: string }; Body: CreateChannelRequest }>('/api/spaces/:id/channels', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, type, topic, categoryId } = request.body;
    const db = getDb();

    const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!space) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'Channel name is required', statusCode: 400 });
    }

    const trimmedName = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (trimmedName.length < 1 || trimmedName.length > 100) {
      return reply.code(400).send({ error: 'Channel name must be between 1 and 100 characters', statusCode: 400 });
    }

    if (!type || !['text', 'voice'].includes(type)) {
      return reply.code(400).send({ error: 'Channel type must be "text" or "voice"', statusCode: 400 });
    }

    // Validate categoryId if provided
    let validCategoryId: string | null = null;
    if (categoryId) {
      const cat = db.select().from(schema.channelCategories)
        .where(and(eq(schema.channelCategories.id, categoryId), eq(schema.channelCategories.spaceId, id)))
        .get();
      if (!cat) {
        return reply.code(400).send({ error: 'Category not found in this space', statusCode: 400 });
      }
      validCategoryId = categoryId;
    }

    // Get max position for ordering
    const existingChannels = db.select()
      .from(schema.channels)
      .where(eq(schema.channels.spaceId, id))
      .all();

    const maxPosition = existingChannels.reduce((max, ch) => Math.max(max, ch.position ?? 0), -1);

    const channelId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.channels).values({
      id: channelId,
      spaceId: id,
      name: trimmedName,
      type,
      topic: topic?.trim() || null,
      position: maxPosition + 1,
      categoryId: validCategoryId,
      createdAt: now,
    }).run();

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
    if (!channel) {
      return reply.code(500).send({ error: 'Failed to create channel', statusCode: 500 });
    }

    const channelData = rowToChannel(channel);

    // Broadcast channel_created with per-user permissions
    // (same pattern as broadcastOverrideChange — permissions are per-user
    // so we must compute individually rather than broadcast uniformly)
    for (const [userId, spaceIds] of connectionManager.getUserSpaceEntries()) {
      if (!spaceIds.has(id)) continue;
      const perms = computePermissions(userId, id, channelId);
      if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
        connectionManager.sendToUser(userId, {
          type: 'channel_created',
          channel: { ...channelData, myPermissions: permissionsToString(perms) },
          spaceId: id,
        });
      }
    }

    return reply.code(201).send(channelData);
  });

  // PATCH /api/channels/:id - Update a channel (admin+)
  app.patch<{ Params: { id: string }; Body: UpdateChannelRequest }>('/api/channels/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, topic, position, categoryId } = request.body;
    const db = getDb();

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    const spaceId = channel.spaceId;
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_CHANNELS, id)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    const updates: Partial<typeof schema.channels.$inferInsert> = {};

    if (name !== undefined) {
      const trimmedName = name.trim().toLowerCase().replace(/\s+/g, '-');
      if (trimmedName.length < 1 || trimmedName.length > 100) {
        return reply.code(400).send({ error: 'Channel name must be between 1 and 100 characters', statusCode: 400 });
      }
      updates.name = trimmedName;
    }

    if (topic !== undefined) {
      updates.topic = topic.trim() || null;
    }

    if (position !== undefined) {
      if (typeof position !== 'number' || position < 0) {
        return reply.code(400).send({ error: 'Position must be a non-negative number', statusCode: 400 });
      }
      updates.position = position;
    }

    if (categoryId !== undefined) {
      if (categoryId === null) {
        updates.categoryId = null;
      } else {
        const cat = db.select().from(schema.channelCategories)
          .where(and(eq(schema.channelCategories.id, categoryId), eq(schema.channelCategories.spaceId, spaceId)))
          .get();
        if (!cat) {
          return reply.code(400).send({ error: 'Category not found in this space', statusCode: 400 });
        }
        updates.categoryId = categoryId;
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'No fields to update', statusCode: 400 });
    }

    db.update(schema.channels).set(updates).where(eq(schema.channels.id, id)).run();

    const updated = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!updated) {
      return reply.code(500).send({ error: 'Failed to update channel', statusCode: 500 });
    }

    const channelData = rowToChannel(updated);

    // Broadcast channel_updated to members with VIEW_CHANNEL
    connectionManager.sendToChannel(spaceId, id, {
      type: 'channel_updated',
      channel: channelData,
      spaceId,
    });

    return reply.code(200).send(channelData);
  });

  // DELETE /api/channels/:id - Delete a channel (admin+)
  app.delete<{ Params: { id: string } }>('/api/channels/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    const spaceId = channel.spaceId;
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_CHANNELS, id)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    // Collect viewers BEFORE deleting (overrides CASCADE-delete with the channel)
    const viewerIds: string[] = [];
    for (const [uid, spaceIds] of connectionManager.getUserSpaceEntries()) {
      if (spaceIds.has(spaceId)) {
        const perms = computePermissions(uid, spaceId, id);
        if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
          viewerIds.push(uid);
        }
      }
    }

    // Delete messages in channel (attachments cascade), then channel
    db.delete(schema.messages).where(eq(schema.messages.channelId, id)).run();
    db.delete(schema.channels).where(eq(schema.channels.id, id)).run();

    // Broadcast channel_deleted only to users who could see the channel
    const deleteEvent = { type: 'channel_deleted' as const, channelId: id, spaceId };
    for (const uid of viewerIds) {
      connectionManager.sendToUser(uid, deleteEvent);
    }

    return reply.code(200).send({ success: true });
  });

  // ─── Channel Override Endpoints ───────────────────────────────────────────

  // GET /api/channels/:id/overrides - List channel permission overrides
  app.get<{ Params: { id: string } }>('/api/channels/:id/overrides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, channel.spaceId, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    const overrides = db.select().from(schema.channelOverrides)
      .where(eq(schema.channelOverrides.channelId, id))
      .all();

    return reply.code(200).send(overrides.map(o => ({
      channelId: o.channelId,
      targetType: o.targetType,
      targetId: o.targetId,
      allow: o.allow,
      deny: o.deny,
    })));
  });

  // PUT /api/channels/:id/overrides - Create or update a channel override
  app.put<{
    Params: { id: string };
    Body: { targetType: string; targetId: string; allow: string; deny: string };
  }>('/api/channels/:id/overrides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { targetType, targetId, allow, deny } = request.body;
    const db = getDb();

    if (!targetType || !['role', 'member'].includes(targetType)) {
      return reply.code(400).send({ error: 'targetType must be "role" or "member"', statusCode: 400 });
    }
    if (!targetId || typeof targetId !== 'string') {
      return reply.code(400).send({ error: 'targetId is required', statusCode: 400 });
    }

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, channel.spaceId, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    // Validate that allow/deny are valid bigint strings
    try {
      BigInt(allow || '0');
      BigInt(deny || '0');
    } catch {
      return reply.code(400).send({ error: 'allow and deny must be valid decimal integer strings', statusCode: 400 });
    }

    // Upsert: delete existing then insert
    db.transaction((tx) => {
      tx.delete(schema.channelOverrides).where(
        and(
          eq(schema.channelOverrides.channelId, id),
          eq(schema.channelOverrides.targetType, targetType),
          eq(schema.channelOverrides.targetId, targetId),
        )
      ).run();

      tx.insert(schema.channelOverrides).values({
        channelId: id,
        targetType,
        targetId,
        allow: allow || '0',
        deny: deny || '0',
      }).run();
    });

    // Notify all space members of the permission change
    broadcastOverrideChange(channel.spaceId, id);
    checkVoicePermissions(channel.spaceId);

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/channels/:id/overrides/:targetType/:targetId - Remove a channel override
  app.delete<{ Params: { id: string; targetType: string; targetId: string } }>(
    '/api/channels/:id/overrides/:targetType/:targetId',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id, targetType, targetId } = request.params;
      const db = getDb();

      const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
      if (!channel) {
        return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
      }

      if (!hasPermission(request.userId, channel.spaceId, PermissionBits.MANAGE_ROLES)) {
        return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
      }

      db.delete(schema.channelOverrides).where(
        and(
          eq(schema.channelOverrides.channelId, id),
          eq(schema.channelOverrides.targetType, targetType),
          eq(schema.channelOverrides.targetId, targetId),
        )
      ).run();

      // Notify all space members of the permission change
      broadcastOverrideChange(channel.spaceId, id);
      checkVoicePermissions(channel.spaceId);

      return reply.code(200).send({ success: true });
    },
  );

  // ─── Channel Category Endpoints ─────────────────────────────────────────────

  // POST /api/spaces/:id/categories - Create a category
  app.post<{ Params: { id: string }; Body: { name: string } }>('/api/spaces/:id/categories', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name } = request.body;
    const db = getDb();

    const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!space) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'Category name is required', statusCode: 400 });
    }

    const trimmedName = name.trim();
    if (trimmedName.length > 100) {
      return reply.code(400).send({ error: 'Category name must be 100 characters or less', statusCode: 400 });
    }

    const existing = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.spaceId, id))
      .all();
    const maxPos = existing.reduce((max, c) => Math.max(max, c.position ?? 0), -1);

    const categoryId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.channelCategories).values({
      id: categoryId,
      spaceId: id,
      name: trimmedName,
      position: maxPos + 1,
      createdAt: now,
    }).run();

    const category = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.id, categoryId)).get();
    if (!category) {
      return reply.code(500).send({ error: 'Failed to create category', statusCode: 500 });
    }

    const categoryData = rowToCategory(category);
    connectionManager.sendToSpace(id, {
      type: 'category_created',
      category: categoryData,
      spaceId: id,
    });

    return reply.code(201).send(categoryData);
  });

  // PATCH /api/categories/:id - Update a category
  app.patch<{ Params: { id: string }; Body: { name?: string; position?: number } }>('/api/categories/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, position } = request.body;
    const db = getDb();

    const category = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.id, id)).get();
    if (!category) {
      return reply.code(404).send({ error: 'Category not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, category.spaceId, PermissionBits.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    const updates: Partial<typeof schema.channelCategories.$inferInsert> = {};

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName || trimmedName.length > 100) {
        return reply.code(400).send({ error: 'Category name must be 1-100 characters', statusCode: 400 });
      }
      updates.name = trimmedName;
    }

    if (position !== undefined) {
      if (typeof position !== 'number' || position < 0) {
        return reply.code(400).send({ error: 'Position must be a non-negative number', statusCode: 400 });
      }
      updates.position = position;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'No fields to update', statusCode: 400 });
    }

    db.update(schema.channelCategories).set(updates)
      .where(eq(schema.channelCategories.id, id)).run();

    const updated = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.id, id)).get();
    if (!updated) {
      return reply.code(500).send({ error: 'Failed to update category', statusCode: 500 });
    }

    const categoryData = rowToCategory(updated);
    connectionManager.sendToSpace(category.spaceId, {
      type: 'category_updated',
      category: categoryData,
      spaceId: category.spaceId,
    });

    return reply.code(200).send(categoryData);
  });

  // DELETE /api/categories/:id - Delete a category
  app.delete<{ Params: { id: string } }>('/api/categories/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const category = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.id, id)).get();
    if (!category) {
      return reply.code(404).send({ error: 'Category not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, category.spaceId, PermissionBits.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    const spaceId = category.spaceId;

    db.transaction((tx) => {
      // Null out categoryId on all channels in this category
      tx.update(schema.channels).set({ categoryId: null })
        .where(eq(schema.channels.categoryId, id)).run();
      // Delete the category
      tx.delete(schema.channelCategories)
        .where(eq(schema.channelCategories.id, id)).run();
    });

    // Broadcast category deletion
    connectionManager.sendToSpace(spaceId, {
      type: 'category_deleted',
      categoryId: id,
      spaceId,
    });

    // Also broadcast updated layout so channels reflect null categoryId
    broadcastChannelLayout(spaceId);

    return reply.code(200).send({ success: true });
  });

  // PATCH /api/spaces/:id/channel-layout - Batch reorder channels + categories
  app.patch<{
    Params: { id: string };
    Body: {
      channels: Array<{ id: string; position: number; categoryId: string | null }>;
      categories: Array<{ id: string; position: number }>;
    };
  }>('/api/spaces/:id/channel-layout', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { channels: channelUpdates, categories: categoryUpdates } = request.body;
    const db = getDb();

    const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!space) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    if (!Array.isArray(channelUpdates) || !Array.isArray(categoryUpdates)) {
      return reply.code(400).send({ error: 'channels and categories arrays are required', statusCode: 400 });
    }

    // Validate all channel IDs belong to this space
    const spaceChannels = db.select().from(schema.channels)
      .where(eq(schema.channels.spaceId, id)).all();
    const spaceChannelIds = new Set(spaceChannels.map(ch => ch.id));
    for (const ch of channelUpdates) {
      if (!spaceChannelIds.has(ch.id)) {
        return reply.code(400).send({ error: `Channel ${ch.id} does not belong to this space`, statusCode: 400 });
      }
      if (typeof ch.position !== 'number' || ch.position < 0) {
        return reply.code(400).send({ error: 'All positions must be non-negative numbers', statusCode: 400 });
      }
    }

    // Validate all category IDs belong to this space
    const spaceCategories = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.spaceId, id)).all();
    const spaceCategoryIds = new Set(spaceCategories.map(c => c.id));
    for (const cat of categoryUpdates) {
      if (!spaceCategoryIds.has(cat.id)) {
        return reply.code(400).send({ error: `Category ${cat.id} does not belong to this space`, statusCode: 400 });
      }
      if (typeof cat.position !== 'number' || cat.position < 0) {
        return reply.code(400).send({ error: 'All positions must be non-negative numbers', statusCode: 400 });
      }
    }

    // Validate category references in channels
    for (const ch of channelUpdates) {
      if (ch.categoryId !== null && !spaceCategoryIds.has(ch.categoryId)) {
        return reply.code(400).send({ error: `Category ${ch.categoryId} does not belong to this space`, statusCode: 400 });
      }
    }

    // Apply all updates in a transaction
    db.transaction((tx) => {
      for (const ch of channelUpdates) {
        tx.update(schema.channels)
          .set({ position: ch.position, categoryId: ch.categoryId })
          .where(eq(schema.channels.id, ch.id))
          .run();
      }
      for (const cat of categoryUpdates) {
        tx.update(schema.channelCategories)
          .set({ position: cat.position })
          .where(eq(schema.channelCategories.id, cat.id))
          .run();
      }
    });

    // Broadcast the updated layout to all space members with per-user channel filtering
    broadcastChannelLayout(id);

    return reply.code(200).send({ success: true });
  });
}

/**
 * Broadcast updated channel layout to all space members.
 * Each user gets only the channels they can view (VIEW_CHANNEL check).
 */
function broadcastChannelLayout(spaceId: string): void {
  const db = getDb();
  const allChannels = db.select().from(schema.channels)
    .where(eq(schema.channels.spaceId, spaceId)).all();
  const allCategories = db.select().from(schema.channelCategories)
    .where(eq(schema.channelCategories.spaceId, spaceId)).all();

  const categoryData = allCategories.map(rowToCategory);

  for (const [userId, spaceIds] of connectionManager.getUserSpaceEntries()) {
    if (!spaceIds.has(spaceId)) continue;

    const visibleChannels: Channel[] = [];
    for (const ch of allChannels) {
      const perms = computePermissions(userId, spaceId, ch.id);
      if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
        visibleChannels.push({
          ...rowToChannel(ch),
          myPermissions: permissionsToString(perms),
        });
      }
    }

    connectionManager.sendToUser(userId, {
      type: 'channel_layout_updated',
      spaceId,
      channels: visibleChannels,
      categories: categoryData,
    });
  }
}
