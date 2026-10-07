import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, hasPermission, getChannelSpaceId, PermissionBits, computePermissions } from '../utils/permissions.js';
import {
  permissionsToString,
  stringToPermissions,
  parsePermissionString,
  overrideChangeRefusal,
  isHiddenFromEveryone,
  idsHiddenFromEveryone,
  overrideVersion,
  type HeldBitsRefusal,
  type OverrideBits,
} from '@backspace/shared/src/permissions.js';
import {
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_NAME_MIN_LENGTH,
  CHANNEL_NAME_MAX_LENGTH,
  CHANNEL_NAME_MIN_LENGTH,
  normalizeCategoryName,
  normalizeChannelName,
} from '@backspace/shared/src/constants.js';
import { connectionManager } from '../ws/handler.js';
import { checkVoicePermissions } from '../ws/events.js';
import { deleteAttachmentFiles } from '../utils/fileCleanup.js';
import { sendError } from '../utils/httpErrors.js';
import { checkChannelTopic } from '../utils/channelTopic.js';
import { canActOnMemberInSpace, canManageRoleInSpace } from '../utils/roleHierarchy.js';
import { viewerReadsPermissionData } from '../utils/permissionDataView.js';
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

/** Whether a category is private (`isHiddenFromEveryone` on its overrides). */
function isCategoryPrivate(categoryId: string, spaceId: string): boolean {
  const overrides = getDb().select().from(schema.categoryOverrides)
    .where(eq(schema.categoryOverrides.categoryId, categoryId))
    .all();
  return isHiddenFromEveryone(overrides, spaceId);
}

/**
 * After a change that may move who can see `channelIds` (an override on them
 * or on their category, or a move to another category), tell each connected
 * member of the space where each channel now stands for them:
 * - a VIEW_CHANNEL holder gets channel_updated (with their myPermissions),
 * - anyone else gets channel_deleted, which removes it from their UI.
 * A member who can see one of these channels that is a voice channel is then
 * sent the voice state they can see now (`pushSpaceVoiceState`), since
 * channel_updated carries no voice presence: a voice channel they just gained
 * shows who is in it at once, as after a role change (websocket.md,
 * `space_voice_state`).
 */
function broadcastChannelVisibility(spaceId: string, channelIds: readonly string[]): void {
  if (channelIds.length === 0) return;
  const db = getDb();
  const channels = db.select().from(schema.channels)
    .where(and(eq(schema.channels.spaceId, spaceId), inArray(schema.channels.id, [...channelIds])))
    .all();
  if (channels.length === 0) return;

  const overrides = db.select().from(schema.channelOverrides)
    .where(inArray(schema.channelOverrides.channelId, channels.map((ch) => ch.id)))
    .all();
  const privateIds = idsHiddenFromEveryone(overrides, (o) => o.channelId, () => spaceId);

  for (const [userId, spaceIds] of connectionManager.getUserSpaceEntries()) {
    if (!spaceIds.has(spaceId)) continue;

    let seesVoiceChannel = false;
    for (const channel of channels) {
      const perms = computePermissions(userId, spaceId, channel.id);
      if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
        if (channel.type === 'voice') seesVoiceChannel = true;
        connectionManager.sendToUser(userId, {
          type: 'channel_updated',
          channel: { ...rowToChannel(channel), isPrivate: privateIds.has(channel.id), myPermissions: permissionsToString(perms) },
          spaceId,
        });
      } else {
        connectionManager.sendToUser(userId, {
          type: 'channel_deleted',
          channelId: channel.id,
          spaceId,
        });
      }
    }
    if (seesVoiceChannel) connectionManager.pushSpaceVoiceState(userId, spaceId);
  }
}

/** After a channel's overrides change, or it moves to another category (`broadcastChannelVisibility`). */
function broadcastOverrideChange(spaceId: string, channelId: string): void {
  broadcastChannelVisibility(spaceId, [channelId]);
}

/**
 * When a category's overrides change, re-evaluate visibility for all channels
 * in that category and send channel_updated/channel_deleted per user
 * (`broadcastChannelVisibility`, one voice state push per member at most).
 * Also broadcasts category_updated with isPrivate for the lock icon.
 */
function broadcastCategoryOverrideChange(spaceId: string, categoryId: string): void {
  const db = getDb();

  const channelsInCategory = db.select({ id: schema.channels.id }).from(schema.channels)
    .where(and(eq(schema.channels.spaceId, spaceId), eq(schema.channels.categoryId, categoryId)))
    .all();

  broadcastChannelVisibility(spaceId, channelsInCategory.map((ch) => ch.id));

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

/**
 * Role hierarchy for an override write (permissions.md, "Role hierarchy"): an
 * override on a role changes what its holders can do in that channel or
 * category, and one on a member moderates that member. So a role target must
 * rank below the actor's top role, and a member target other than the actor
 * must rank below the actor. `mode` 'delete' lets an override on a role that
 * no longer exists be cleaned up; a write needs the role to be in the space.
 */
function overrideTargetRefusal(
  actorId: string,
  spaceId: string,
  targetType: string,
  targetId: string,
  mode: 'write' | 'delete',
): { status: 400 | 403; code: 'role_not_in_space' | 'role_hierarchy' } | null {
  if (targetType === 'role') {
    const role = getDb().select({ position: schema.roles.position }).from(schema.roles)
      .where(and(eq(schema.roles.id, targetId), eq(schema.roles.spaceId, spaceId)))
      .get();
    if (!role) return mode === 'write' ? { status: 400, code: 'role_not_in_space' } : null;
    return canManageRoleInSpace(spaceId, actorId, role.position ?? 0) ? null : { status: 403, code: 'role_hierarchy' };
  }
  if (targetType === 'member' && targetId !== actorId && !canActOnMemberInSpace(spaceId, actorId, targetId)) {
    return { status: 403, code: 'role_hierarchy' };
  }
  return null;
}

/**
 * The allow and deny of an override write, or null when either is not a
 * permissions string (`parsePermissionString`). A field left out means no
 * bits, as it always has.
 */
function parseOverrideBits(allow: unknown, deny: unknown): OverrideBits | null {
  const allowBits = allow === undefined ? 0n : parsePermissionString(allow);
  const denyBits = deny === undefined ? 0n : parsePermissionString(deny);
  return allowBits === null || denyBits === null ? null : { allow: allowBits, deny: denyBits };
}

/** A stored override row as bits, or null when there is none. */
function storedOverrideBits(row: { allow: string; deny: string } | undefined): OverrideBits | null {
  return row ? { allow: stringToPermissions(row.allow), deny: stringToPermissions(row.deny) } : null;
}

/**
 * Held-bits rule for an override write (permissions.md, "Held-bits rule"):
 * the actor may only switch bits they hold in the space. The comparison is
 * against the stored row, so an unheld bit someone more senior set can stay
 * while the actor edits the others. `after` null is a delete.
 */
function overrideWriteRefusal(
  actorId: string,
  spaceId: string,
  before: { allow: string; deny: string } | undefined,
  after: OverrideBits | null,
): HeldBitsRefusal | null {
  return overrideChangeRefusal(computePermissions(actorId, spaceId), storedOverrideBits(before), after);
}

/**
 * The `version` an override write names (permissions.md, "Concurrent
 * edits"): the version of the row the editor loaded, `NO_OVERRIDE_VERSION`
 * when it loaded none. `undefined` when the request sends none, which is a
 * client from before the check: its write is not compared, as before. Null
 * when the field is there but not a string.
 */
function parseExpectedVersion(value: unknown): { expected: string | undefined } | null {
  if (value === undefined) return { expected: undefined };
  return typeof value === 'string' && value.length > 0 ? { expected: value } : null;
}

/**
 * Whether an override write was made against a row that has changed since
 * the editor loaded it. Requests without a version are never stale. The
 * check, the held-bits check and the write run with no await between them,
 * and better-sqlite3 is synchronous, so no other request can change the row
 * in between.
 */
function isStaleOverrideWrite(stored: { allow: string; deny: string } | undefined, expected: string | undefined): boolean {
  return expected !== undefined && overrideVersion(stored) !== expected;
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

    const trimmedName = normalizeChannelName(name);
    if (trimmedName.length < CHANNEL_NAME_MIN_LENGTH || trimmedName.length > CHANNEL_NAME_MAX_LENGTH) {
      return sendError(reply, 400, 'channel_name_length', { min: CHANNEL_NAME_MIN_LENGTH, max: CHANNEL_NAME_MAX_LENGTH });
    }

    if (!type || !['text', 'voice'].includes(type)) {
      return sendError(reply, 400, 'channel_type_invalid');
    }

    let storedTopic: string | null = null;
    if (topic !== undefined) {
      const checked = checkChannelTopic(topic);
      if (!checked.ok) {
        return sendError(reply, 400, checked.code, checked.details);
      }
      storedTopic = checked.topic;
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
      topic: storedTopic,
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
      if (typeof name !== 'string') {
        return sendError(reply, 400, 'channel_name_required');
      }
      const trimmedName = normalizeChannelName(name);
      if (trimmedName.length < CHANNEL_NAME_MIN_LENGTH || trimmedName.length > CHANNEL_NAME_MAX_LENGTH) {
        return sendError(reply, 400, 'channel_name_length', { min: CHANNEL_NAME_MIN_LENGTH, max: CHANNEL_NAME_MAX_LENGTH });
      }
      updates.name = trimmedName;
    }

    if (topic !== undefined) {
      const checked = checkChannelTopic(topic);
      if (!checked.ok) {
        return sendError(reply, 400, checked.code, checked.details);
      }
      updates.topic = checked.topic;
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

    // Override rows go only to viewers who manage roles (utils/permissionDataView.ts).
    if (!viewerReadsPermissionData(computePermissions(request.userId, channel.spaceId))) {
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
      version: overrideVersion(o),
    })));
  });

  // PUT /api/channels/:id/overrides - Create or update a channel override
  app.put<{
    Params: { id: string };
    Body: { targetType: string; targetId: string; allow?: unknown; deny?: unknown; version?: unknown };
  }>('/api/channels/:id/overrides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { targetType, targetId, allow, deny, version } = request.body;
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

    const bits = parseOverrideBits(allow, deny);
    if (!bits) {
      return sendError(reply, 400, 'override_bits_invalid');
    }
    const expectedVersion = parseExpectedVersion(version);
    if (!expectedVersion) {
      return sendError(reply, 400, 'validation_failed');
    }

    const targetRefusal = overrideTargetRefusal(request.userId, channel.spaceId, targetType, targetId, 'write');
    if (targetRefusal) {
      return sendError(reply, targetRefusal.status, targetRefusal.code, targetRefusal.code === 'role_not_in_space' ? { roleId: targetId } : undefined);
    }

    const existingChannelOverride = db.select().from(schema.channelOverrides).where(and(
      eq(schema.channelOverrides.channelId, id),
      eq(schema.channelOverrides.targetType, targetType),
      eq(schema.channelOverrides.targetId, targetId),
    )).get();
    // Concurrent edits: refuse a write made from an outdated copy of the row.
    if (isStaleOverrideWrite(existingChannelOverride, expectedVersion.expected)) {
      return sendError(reply, 409, 'overrides_conflict');
    }

    // Privilege escalation guard: only bits the caller holds may change
    const escalation = overrideWriteRefusal(request.userId, channel.spaceId, existingChannelOverride, bits);
    if (escalation) {
      return sendError(reply, 403, escalation);
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
        allow: permissionsToString(bits.allow),
        deny: permissionsToString(bits.deny),
      }).run();
    });

    // Notify all space members of the permission change
    broadcastOverrideChange(channel.spaceId, id);
    checkVoicePermissions(channel.spaceId);

    return reply.code(200).send({
      success: true,
      version: overrideVersion({ allow: permissionsToString(bits.allow), deny: permissionsToString(bits.deny) }),
    });
  });

  // DELETE /api/channels/:id/overrides/:targetType/:targetId - Remove a channel override
  app.delete<{ Params: { id: string; targetType: string; targetId: string }; Querystring: { version?: unknown } }>(
    '/api/channels/:id/overrides/:targetType/:targetId',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id, targetType, targetId } = request.params;
      const db = getDb();

      const expectedVersion = parseExpectedVersion(request.query.version);
      if (!expectedVersion) {
        return sendError(reply, 400, 'validation_failed');
      }

      const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
      if (!channel) {
        return sendError(reply, 404, 'channel_not_found');
      }

      if (!hasPermission(request.userId, channel.spaceId, PermissionBits.MANAGE_ROLES)) {
        return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
      }

      const targetRefusal = overrideTargetRefusal(request.userId, channel.spaceId, targetType, targetId, 'delete');
      if (targetRefusal) {
        return sendError(reply, targetRefusal.status, targetRefusal.code);
      }

      // Deleting clears every bit the override sets; without this check a
      // delete and re-create would get round the held-bits rule on PUT.
      const existing = db.select().from(schema.channelOverrides).where(and(
        eq(schema.channelOverrides.channelId, id),
        eq(schema.channelOverrides.targetType, targetType),
        eq(schema.channelOverrides.targetId, targetId),
      )).get();
      // Concurrent edits: a row someone changed since it was loaded is not
      // deleted. One already gone is the state the delete asks for.
      if (existing && isStaleOverrideWrite(existing, expectedVersion.expected)) {
        return sendError(reply, 409, 'overrides_conflict');
      }
      const escalation = overrideWriteRefusal(request.userId, channel.spaceId, existing, null);
      if (escalation) {
        return sendError(reply, 403, escalation);
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

    // Override rows go only to viewers who manage roles (utils/permissionDataView.ts).
    if (!viewerReadsPermissionData(computePermissions(request.userId, category.spaceId))) {
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
      version: overrideVersion(o),
    })));
  });

  // PUT /api/categories/:id/overrides
  app.put<{
    Params: { id: string };
    Body: { targetType: string; targetId: string; allow?: unknown; deny?: unknown; version?: unknown };
  }>('/api/categories/:id/overrides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { targetType, targetId, allow, deny, version } = request.body;
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

    const bits = parseOverrideBits(allow, deny);
    if (!bits) {
      return sendError(reply, 400, 'override_bits_invalid');
    }
    const expectedVersion = parseExpectedVersion(version);
    if (!expectedVersion) {
      return sendError(reply, 400, 'validation_failed');
    }

    const targetRefusal = overrideTargetRefusal(request.userId, category.spaceId, targetType, targetId, 'write');
    if (targetRefusal) {
      return sendError(reply, targetRefusal.status, targetRefusal.code, targetRefusal.code === 'role_not_in_space' ? { roleId: targetId } : undefined);
    }

    const existingCategoryOverride = db.select().from(schema.categoryOverrides).where(and(
      eq(schema.categoryOverrides.categoryId, id),
      eq(schema.categoryOverrides.targetType, targetType),
      eq(schema.categoryOverrides.targetId, targetId),
    )).get();
    // Concurrent edits (see the channel route).
    if (isStaleOverrideWrite(existingCategoryOverride, expectedVersion.expected)) {
      return sendError(reply, 409, 'overrides_conflict');
    }

    // Privilege escalation guard (matches channel override pattern)
    const escalation = overrideWriteRefusal(request.userId, category.spaceId, existingCategoryOverride, bits);
    if (escalation) {
      return sendError(reply, 403, escalation);
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
        allow: permissionsToString(bits.allow),
        deny: permissionsToString(bits.deny),
      }).run();
    });

    broadcastCategoryOverrideChange(category.spaceId, id);
    checkVoicePermissions(category.spaceId);

    return reply.code(200).send({
      success: true,
      version: overrideVersion({ allow: permissionsToString(bits.allow), deny: permissionsToString(bits.deny) }),
    });
  });

  // DELETE /api/categories/:id/overrides/:targetType/:targetId
  app.delete<{ Params: { id: string; targetType: string; targetId: string }; Querystring: { version?: unknown } }>(
    '/api/categories/:id/overrides/:targetType/:targetId',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id, targetType, targetId } = request.params;
      const db = getDb();

      const expectedVersion = parseExpectedVersion(request.query.version);
      if (!expectedVersion) {
        return sendError(reply, 400, 'validation_failed');
      }

      const category = db.select().from(schema.channelCategories)
        .where(eq(schema.channelCategories.id, id)).get();
      if (!category) {
        return sendError(reply, 404, 'category_not_found');
      }

      if (!hasPermission(request.userId, category.spaceId, PermissionBits.MANAGE_ROLES)) {
        return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
      }

      const targetRefusal = overrideTargetRefusal(request.userId, category.spaceId, targetType, targetId, 'delete');
      if (targetRefusal) {
        return sendError(reply, targetRefusal.status, targetRefusal.code);
      }

      // Deleting clears every bit the override sets (see the channel route).
      const existing = db.select().from(schema.categoryOverrides).where(and(
        eq(schema.categoryOverrides.categoryId, id),
        eq(schema.categoryOverrides.targetType, targetType),
        eq(schema.categoryOverrides.targetId, targetId),
      )).get();
      // Concurrent edits (see the channel route).
      if (existing && isStaleOverrideWrite(existing, expectedVersion.expected)) {
        return sendError(reply, 409, 'overrides_conflict');
      }
      const escalation = overrideWriteRefusal(request.userId, category.spaceId, existing, null);
      if (escalation) {
        return sendError(reply, 403, escalation);
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

    const trimmedName = normalizeCategoryName(name);
    if (trimmedName.length > CATEGORY_NAME_MAX_LENGTH) {
      return sendError(reply, 400, 'category_name_length', { min: CATEGORY_NAME_MIN_LENGTH, max: CATEGORY_NAME_MAX_LENGTH });
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
      if (typeof name !== 'string') {
        return sendError(reply, 400, 'category_name_required');
      }
      const trimmedName = normalizeCategoryName(name);
      if (trimmedName.length < CATEGORY_NAME_MIN_LENGTH || trimmedName.length > CATEGORY_NAME_MAX_LENGTH) {
        return sendError(reply, 400, 'category_name_length', { min: CATEGORY_NAME_MIN_LENGTH, max: CATEGORY_NAME_MAX_LENGTH });
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
    // Leaving the category drops its overrides from these channels, so who
    // can see them may change.
    const releasedChannels = db.select({ id: schema.channels.id, type: schema.channels.type }).from(schema.channels)
      .where(eq(schema.channels.categoryId, id)).all();

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
    broadcastChannelLayout(spaceId, releasedChannels.map((ch) => ch.id));
    if (releasedChannels.some((ch) => ch.type === 'voice')) {
      checkVoicePermissions(spaceId);
    }

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

    // Channels whose category changed inherit other overrides now, so who can
    // see them may have changed.
    const previousCategory = new Map(spaceChannels.map((ch) => [ch.id, ch.categoryId ?? null]));
    const movedChannelIds = channelUpdates
      .filter((ch) => previousCategory.get(ch.id) !== ch.categoryId)
      .map((ch) => ch.id);

    // Broadcast the updated layout to all space members with per-user channel filtering
    broadcastChannelLayout(id, movedChannelIds);
    const movedIds = new Set(movedChannelIds);
    if (spaceChannels.some((ch) => ch.type === 'voice' && movedIds.has(ch.id))) {
      checkVoicePermissions(id);
    }

    return reply.code(200).send({ success: true });
  });
}

/**
 * Broadcast updated channel layout to all space members.
 * Each user gets only the channels they can view (VIEW_CHANNEL check).
 * `movedChannelIds` are the channels that changed category: a member who can
 * see one of them that is a voice channel is also sent the voice state they
 * can see now (`pushSpaceVoiceState`), as `broadcastChannelVisibility` does,
 * since the layout carries no voice presence.
 */
function broadcastChannelLayout(spaceId: string, movedChannelIds: readonly string[]): void {
  const db = getDb();
  const allChannels = db.select().from(schema.channels)
    .where(eq(schema.channels.spaceId, spaceId)).all();
  const allCategories = db.select().from(schema.channelCategories)
    .where(eq(schema.channelCategories.spaceId, spaceId)).all();
  const channelPrivateIds = idsHiddenFromEveryone(
    db.select().from(schema.channelOverrides).where(inArray(
      schema.channelOverrides.channelId,
      db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.spaceId, spaceId)),
    )).all(),
    (o) => o.channelId,
    () => spaceId,
  );
  const categoryPrivateIds = idsHiddenFromEveryone(
    db.select().from(schema.categoryOverrides).where(inArray(
      schema.categoryOverrides.categoryId,
      db.select({ id: schema.channelCategories.id }).from(schema.channelCategories).where(eq(schema.channelCategories.spaceId, spaceId)),
    )).all(),
    (o) => o.categoryId,
    () => spaceId,
  );
  const moved = new Set(movedChannelIds);

  const categoryData = allCategories.map(c => ({
    ...rowToCategory(c),
    isPrivate: categoryPrivateIds.has(c.id),
  }));

  for (const [userId, spaceIds] of connectionManager.getUserSpaceEntries()) {
    if (!spaceIds.has(spaceId)) continue;

    const visibleChannels: Channel[] = [];
    let seesMovedVoiceChannel = false;
    for (const ch of allChannels) {
      const perms = computePermissions(userId, spaceId, ch.id);
      if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
        if (ch.type === 'voice' && moved.has(ch.id)) seesMovedVoiceChannel = true;
        visibleChannels.push({
          ...rowToChannel(ch),
          isPrivate: channelPrivateIds.has(ch.id),
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
    if (seesMovedVoiceChannel) connectionManager.pushSpaceVoiceState(userId, spaceId);
  }
}
