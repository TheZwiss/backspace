import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, hasPermission, getChannelSpaceId, PermissionBits, computePermissions } from '../utils/permissions.js';
import { permissionsToString } from '@backspace/shared/src/permissions.js';
import { connectionManager } from '../ws/handler.js';
import { checkVoicePermissions } from '../ws/events.js';
import { deleteAttachmentFiles } from '../utils/fileCleanup.js';
import { sendError } from '../utils/httpErrors.js';
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
 * Check if a channel is private by looking for a VIEW_CHANNEL deny on @everyone.
 * The @everyone role ID equals the space ID.
 */
function isChannelPrivate(channelId: string, spaceId: string): boolean {
  const db = getDb();
  const override = db.select().from(schema.channelOverrides).where(
    and(
      eq(schema.channelOverrides.channelId, channelId),
      eq(schema.channelOverrides.targetType, 'role'),
      eq(schema.channelOverrides.targetId, spaceId),
    )
  ).get();
  if (!override) return false;
  const denyBits = BigInt(override.deny || '0');
  return (denyBits & PermissionBits.VIEW_CHANNEL) !== 0n;
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
  const priv = isChannelPrivate(channelId, spaceId);

  for (const [userId, spaceIds] of connectionManager.getUserSpaceEntries()) {
    if (!spaceIds.has(spaceId)) continue;

    const perms = computePermissions(userId, spaceId, channelId);
    if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
      connectionManager.sendToUser(userId, {
        type: 'channel_updated',
        channel: { ...channelData, isPrivate: priv, myPermissions: permissionsToString(perms) },
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

/**
 * Check if a category is private by looking for VIEW_CHANNEL deny on @everyone.
 */
function isCategoryPrivate(categoryId: string, spaceId: string): boolean {
  const db = getDb();
  const override = db.select().from(schema.categoryOverrides).where(
    and(
      eq(schema.categoryOverrides.categoryId, categoryId),
      eq(schema.categoryOverrides.targetType, 'role'),
      eq(schema.categoryOverrides.targetId, spaceId),
    )
  ).get();
  if (!override) return false;
  const denyBits = BigInt(override.deny || '0');
  return (denyBits & PermissionBits.VIEW_CHANNEL) !== 0n;
}

/**
 * When a category's overrides change, re-evaluate visibility for all channels
 * in that category and send channel_updated/channel_deleted per user.
 * Also broadcasts category_updated with isPrivate for the lock icon.
 */
function broadcastCategoryOverrideChange(spaceId: string, categoryId: string): void {
  const db = getDb();

  const channelsInCategory = db.select().from(schema.channels)
    .where(and(eq(schema.channels.spaceId, spaceId), eq(schema.channels.categoryId, categoryId)))
    .all();

  for (const ch of channelsInCategory) {
    broadcastOverrideChange(spaceId, ch.id);
  }

  const category = db.select().from(schema.channelCategories)
    .where(eq(schema.channelCategories.id, categoryId)).get();
  if (category) {
    const isPrivate = isCategoryPrivate(categoryId, spaceId);
    connectionManager.sendToSpace(spaceId, {
      type: 'category_updated',
      category: { ...rowToCategory(category), isPrivate },
      spaceId,
    });
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
      return sendError(reply, 404, 'space_not_found');
    }

    if (!isMember(id, request.userId)) {
      return sendError(reply, 403, 'not_space_member');
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
      return sendError(reply, 404, 'space_not_found');
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_CHANNELS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_CHANNELS' });
    }

    if (!name || typeof name !== 'string') {
      return sendError(reply, 400, 'channel_name_required');
    }

    const trimmedName = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (trimmedName.length < 1 || trimmedName.length > 100) {
      return sendError(reply, 400, 'channel_name_length', { min: 1, max: 100 });
    }

    if (!type || !['text', 'voice'].includes(type)) {
      return sendError(reply, 400, 'channel_type_invalid');
    }

    // Validate categoryId if provided
    let validCategoryId: string | null = null;
    if (categoryId) {
      const cat = db.select().from(schema.channelCategories)
        .where(and(eq(schema.channelCategories.id, categoryId), eq(schema.channelCategories.spaceId, id)))
        .get();
      if (!cat) {
        return sendError(reply, 400, 'category_not_in_space', { id: categoryId });
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
      return sendError(reply, 500, 'internal_error');
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
          channel: { ...channelData, isPrivate: false, myPermissions: permissionsToString(perms) },
          spaceId: id,
        });
      }
    }

    // Return the channel with the creator's computed permissions (same shape as
    // the channel_created WS event) so the client can render it immediately
    // without waiting for the broadcast to round-trip.
    const creatorPerms = computePermissions(request.userId, id, channelId);
    return reply.code(201).send({
      ...channelData,
      isPrivate: false,
      myPermissions: permissionsToString(creatorPerms),
    });
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
      return sendError(reply, 404, 'channel_not_found');
    }

    const spaceId = channel.spaceId;
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_CHANNELS, id)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_CHANNELS' });
    }

    const updates: Partial<typeof schema.channels.$inferInsert> = {};

    if (name !== undefined) {
      const trimmedName = name.trim().toLowerCase().replace(/\s+/g, '-');
      if (trimmedName.length < 1 || trimmedName.length > 100) {
        return sendError(reply, 400, 'channel_name_length', { min: 1, max: 100 });
      }
      updates.name = trimmedName;
    }

    if (topic !== undefined) {
      updates.topic = topic.trim() || null;
    }

    if (position !== undefined) {
      if (typeof position !== 'number' || position < 0) {
        return sendError(reply, 400, 'position_invalid');
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
          return sendError(reply, 400, 'category_not_in_space', { id: categoryId });
        }
        updates.categoryId = categoryId;
      }
    }

    if (Object.keys(updates).length === 0) {
      return sendError(reply, 400, 'no_fields_to_update');
    }

    db.update(schema.channels).set(updates).where(eq(schema.channels.id, id)).run();

    const updated = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!updated) {
      return sendError(reply, 500, 'internal_error');
    }

    const channelData = rowToChannel(updated);

    // If categoryId changed, permissions may have changed due to different category overrides
    if (categoryId !== undefined) {
      broadcastOverrideChange(spaceId, id);
      if (channel.type === 'voice') {
        checkVoicePermissions(spaceId);
      }
    } else {
      // Simple broadcast for non-permission-affecting changes
      connectionManager.sendToChannel(spaceId, id, {
        type: 'channel_updated',
        channel: channelData,
        spaceId,
      });
    }

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
      return sendError(reply, 404, 'channel_not_found');
    }

    const spaceId = channel.spaceId;
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_CHANNELS, id)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_CHANNELS' });
    }

    // Disconnect voice users before deletion
    const participants = connectionManager.getRoomParticipants(id);
    if (participants.size > 0) {
      for (const participantId of Array.from(participants)) {
        connectionManager.leaveRoom(id, participantId);
        connectionManager.clearVoiceUserStatus(participantId);
        connectionManager.sendToSpace(spaceId, {
          type: 'voice_state_update', channelId: id, userId: participantId, action: 'leave',
        });
        connectionManager.sendToUser(participantId, {
          type: 'voice_disconnected', userId: participantId, channelId: id,
        });
      }
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

    // Collect attachment filenames BEFORE cascade deletes DB records
    const channelMsgIds = db.select({ id: schema.messages.id })
      .from(schema.messages).where(eq(schema.messages.channelId, id)).all().map(m => m.id);

    let attachmentRows: { filename: string }[] = [];
    if (channelMsgIds.length > 0) {
      attachmentRows = db.select({ filename: schema.attachments.filename })
        .from(schema.attachments).where(inArray(schema.attachments.messageId, channelMsgIds)).all();
    }

    // Clean up read_states (no FK, rows would be orphaned)
    db.delete(schema.readStates).where(eq(schema.readStates.channelId, id)).run();

    // Delete messages in channel (attachments cascade), then channel
    db.delete(schema.messages).where(eq(schema.messages.channelId, id)).run();
    db.delete(schema.channels).where(eq(schema.channels.id, id)).run();

    // Delete attachment files from disk
    deleteAttachmentFiles(attachmentRows);

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
      return sendError(reply, 404, 'channel_not_found');
    }

    if (!hasPermission(request.userId, channel.spaceId, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
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
      return sendError(reply, 400, 'override_target_invalid');
    }
    if (!targetId || typeof targetId !== 'string') {
      return sendError(reply, 400, 'override_target_required');
    }

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!channel) {
      return sendError(reply, 404, 'channel_not_found');
    }

    if (!hasPermission(request.userId, channel.spaceId, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    // Validate that allow/deny are valid bigint strings
    let allowBits: bigint;
    let denyBits: bigint;
    try {
      allowBits = BigInt(allow || '0');
      denyBits = BigInt(deny || '0');
    } catch {
      return sendError(reply, 400, 'override_bits_invalid');
    }

    // Privilege escalation guard: non-admin users can only grant permissions they possess
    const callerPerms = computePermissions(request.userId, channel.spaceId);
    if ((callerPerms & PermissionBits.ADMINISTRATOR) === 0n) {
      const escalatedAllow = allowBits & ~callerPerms;
      if (escalatedAllow !== 0n) {
        return sendError(reply, 403, 'cannot_grant_unowned_permissions');
      }
      const escalatedDeny = denyBits & ~callerPerms;
      if (escalatedDeny !== 0n) {
        return sendError(reply, 403, 'cannot_deny_unowned_permissions');
      }
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
        return sendError(reply, 404, 'channel_not_found');
      }

      if (!hasPermission(request.userId, channel.spaceId, PermissionBits.MANAGE_ROLES)) {
        return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
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

  // ─── Category Override Endpoints ─────────────────────────────────────────

  // GET /api/categories/:id/overrides
  app.get<{ Params: { id: string } }>('/api/categories/:id/overrides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const category = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.id, id)).get();
    if (!category) {
      return sendError(reply, 404, 'category_not_found');
    }

    if (!isMember(category.spaceId, request.userId)) {
      return sendError(reply, 403, 'not_space_member');
    }

    if (!hasPermission(request.userId, category.spaceId, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    const overrides = db.select().from(schema.categoryOverrides)
      .where(eq(schema.categoryOverrides.categoryId, id))
      .all();

    return reply.code(200).send(overrides.map(o => ({
      categoryId: o.categoryId,
      targetType: o.targetType,
      targetId: o.targetId,
      allow: o.allow,
      deny: o.deny,
    })));
  });

  // PUT /api/categories/:id/overrides
  app.put<{
    Params: { id: string };
    Body: { targetType: string; targetId: string; allow: string; deny: string };
  }>('/api/categories/:id/overrides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { targetType, targetId, allow, deny } = request.body;
    const db = getDb();

    if (!targetType || !['role', 'member'].includes(targetType)) {
      return sendError(reply, 400, 'override_target_invalid');
    }
    if (!targetId || typeof targetId !== 'string') {
      return sendError(reply, 400, 'override_target_required');
    }

    const category = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.id, id)).get();
    if (!category) {
      return sendError(reply, 404, 'category_not_found');
    }

    if (!hasPermission(request.userId, category.spaceId, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    let allowBits: bigint;
    let denyBits: bigint;
    try {
      allowBits = BigInt(allow || '0');
      denyBits = BigInt(deny || '0');
    } catch {
      return sendError(reply, 400, 'override_bits_invalid');
    }

    // Privilege escalation guard (matches channel override pattern)
    const callerPerms = computePermissions(request.userId, category.spaceId);
    if ((callerPerms & PermissionBits.ADMINISTRATOR) === 0n) {
      const escalatedAllow = allowBits & ~callerPerms;
      if (escalatedAllow !== 0n) {
        return sendError(reply, 403, 'cannot_grant_unowned_permissions');
      }
      const escalatedDeny = denyBits & ~callerPerms;
      if (escalatedDeny !== 0n) {
        return sendError(reply, 403, 'cannot_deny_unowned_permissions');
      }
    }

    db.transaction((tx) => {
      tx.delete(schema.categoryOverrides).where(
        and(
          eq(schema.categoryOverrides.categoryId, id),
          eq(schema.categoryOverrides.targetType, targetType),
          eq(schema.categoryOverrides.targetId, targetId),
        )
      ).run();

      tx.insert(schema.categoryOverrides).values({
        categoryId: id,
        targetType,
        targetId,
        allow: allow || '0',
        deny: deny || '0',
      }).run();
    });

    broadcastCategoryOverrideChange(category.spaceId, id);
    checkVoicePermissions(category.spaceId);

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/categories/:id/overrides/:targetType/:targetId
  app.delete<{ Params: { id: string; targetType: string; targetId: string } }>(
    '/api/categories/:id/overrides/:targetType/:targetId',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id, targetType, targetId } = request.params;
      const db = getDb();

      const category = db.select().from(schema.channelCategories)
        .where(eq(schema.channelCategories.id, id)).get();
      if (!category) {
        return sendError(reply, 404, 'category_not_found');
      }

      if (!hasPermission(request.userId, category.spaceId, PermissionBits.MANAGE_ROLES)) {
        return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
      }

      db.delete(schema.categoryOverrides).where(
        and(
          eq(schema.categoryOverrides.categoryId, id),
          eq(schema.categoryOverrides.targetType, targetType),
          eq(schema.categoryOverrides.targetId, targetId),
        )
      ).run();

      broadcastCategoryOverrideChange(category.spaceId, id);
      checkVoicePermissions(category.spaceId);

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
      return sendError(reply, 404, 'space_not_found');
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_CHANNELS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_CHANNELS' });
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return sendError(reply, 400, 'category_name_required');
    }

    const trimmedName = name.trim();
    if (trimmedName.length > 100) {
      return sendError(reply, 400, 'category_name_length', { min: 1, max: 100 });
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
      return sendError(reply, 500, 'internal_error');
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
      return sendError(reply, 404, 'category_not_found');
    }

    if (!hasPermission(request.userId, category.spaceId, PermissionBits.MANAGE_CHANNELS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_CHANNELS' });
    }

    const updates: Partial<typeof schema.channelCategories.$inferInsert> = {};

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName || trimmedName.length > 100) {
        return sendError(reply, 400, 'category_name_length', { min: 1, max: 100 });
      }
      updates.name = trimmedName;
    }

    if (position !== undefined) {
      if (typeof position !== 'number' || position < 0) {
        return sendError(reply, 400, 'position_invalid');
      }
      updates.position = position;
    }

    if (Object.keys(updates).length === 0) {
      return sendError(reply, 400, 'no_fields_to_update');
    }

    db.update(schema.channelCategories).set(updates)
      .where(eq(schema.channelCategories.id, id)).run();

    const updated = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.id, id)).get();
    if (!updated) {
      return sendError(reply, 500, 'internal_error');
    }

    const updatedData = { ...rowToCategory(updated), isPrivate: isCategoryPrivate(id, category.spaceId) };
    connectionManager.sendToSpace(category.spaceId, {
      type: 'category_updated',
      category: updatedData,
      spaceId: category.spaceId,
    });

    return reply.code(200).send(updatedData);
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
      return sendError(reply, 404, 'category_not_found');
    }

    if (!hasPermission(request.userId, category.spaceId, PermissionBits.MANAGE_CHANNELS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_CHANNELS' });
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
      return sendError(reply, 404, 'space_not_found');
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_CHANNELS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_CHANNELS' });
    }

    if (!Array.isArray(channelUpdates) || !Array.isArray(categoryUpdates)) {
      return sendError(reply, 400, 'layout_arrays_required');
    }

    // Validate all channel IDs belong to this space
    const spaceChannels = db.select().from(schema.channels)
      .where(eq(schema.channels.spaceId, id)).all();
    const spaceChannelIds = new Set(spaceChannels.map(ch => ch.id));
    for (const ch of channelUpdates) {
      if (!spaceChannelIds.has(ch.id)) {
        return sendError(reply, 400, 'channel_not_in_space', { id: ch.id });
      }
      if (typeof ch.position !== 'number' || ch.position < 0) {
        return sendError(reply, 400, 'position_invalid');
      }
    }

    // Validate all category IDs belong to this space
    const spaceCategories = db.select().from(schema.channelCategories)
      .where(eq(schema.channelCategories.spaceId, id)).all();
    const spaceCategoryIds = new Set(spaceCategories.map(c => c.id));
    for (const cat of categoryUpdates) {
      if (!spaceCategoryIds.has(cat.id)) {
        return sendError(reply, 400, 'category_not_in_space', { id: cat.id });
      }
      if (typeof cat.position !== 'number' || cat.position < 0) {
        return sendError(reply, 400, 'position_invalid');
      }
    }

    // Validate category references in channels
    for (const ch of channelUpdates) {
      if (ch.categoryId !== null && !spaceCategoryIds.has(ch.categoryId)) {
        return sendError(reply, 400, 'category_not_in_space', { id: ch.categoryId });
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

  const categoryData = allCategories.map(c => ({
    ...rowToCategory(c),
    isPrivate: isCategoryPrivate(c.id, spaceId),
  }));

  for (const [userId, spaceIds] of connectionManager.getUserSpaceEntries()) {
    if (!spaceIds.has(spaceId)) continue;

    const visibleChannels: Channel[] = [];
    for (const ch of allChannels) {
      const perms = computePermissions(userId, spaceId, ch.id);
      if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
        visibleChannels.push({
          ...rowToChannel(ch),
          isPrivate: isChannelPrivate(ch.id, spaceId),
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
