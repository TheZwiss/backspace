import path from 'path';
import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, getRawDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { markDirectoryDirty } from '../directory/state.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, isSpaceOwner, isBanned, hasPermission, computePermissions, PermissionBits } from '../utils/permissions.js';
import { DEFAULT_EVERYONE_PERMISSIONS, ALL_PERMISSIONS, permissionsToString, stringToPermissions, parsePermissionString, roleBitsChangeRefusal, idsHiddenFromEveryone, rolePermissionsVersion, type HeldBitsRefusal } from '@backspace/shared/src/permissions.js';
import crypto from 'crypto';
import { connectionManager } from '../ws/handler.js';
import { deleteAttachmentFiles, deleteUploadFile, deleteAttachmentByFilename } from '../utils/fileCleanup.js';
import { resizeProfileImage } from '../utils/thumbnail.js';
import { config } from '../config.js';
import type {
  CreateSpaceRequest,
  UpdateSpaceRequest,
  JoinSpaceRequest,
  UpdateMemberRequest,
  Space,
  Channel,
  ChannelCategory,
  MemberWithUser,
  SpaceWithChannelsAndMembers,
  Role,
} from '@backspace/shared';
import { AVATAR_COLORS } from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';
import { checkVoicePermissions } from '../ws/events.js';
import { getLocalInviteSnapshot } from '../utils/spaceInviteSnapshot.js';
import { sendError } from '../utils/httpErrors';
import { canActOnMemberInSpace, canManageRoleInSpace, getHierarchyStanding } from '../utils/roleHierarchy.js';
import { canActOnMember, canManageRoleAt } from '@backspace/shared/src/permissions.js';
import { moveRoleToPosition, normalizeRolePositions, positionNextTo } from '../db/rolePositions.js';
import { memberRolesView, roleView, rolesForViewer, viewerReadsPermissionData } from '../utils/permissionDataView.js';

function rowToSpace(row: typeof schema.spaces.$inferSelect): Space {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    banner: row.banner ?? null,
    avatarColor: (row.avatarColor as Space['avatarColor']) ?? null,
    ownerId: row.ownerId,
    inviteCode: row.inviteCode,
    visibility: (row.visibility ?? 'private') as Space['visibility'],
    directoryListed: row.directoryListed === 1,
    description: row.description ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * The space columns the directory document serves (spec section 4). A change
 * to any of them on a listed space owes a ping.
 */
const DIRECTORY_SPACE_FIELDS = ['name', 'description', 'icon', 'banner', 'avatarColor', 'visibility'] as const;

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

function generateInviteCode(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * After a change to the space's roles or to a member's roles: every connected
 * member is told with `space_access_changed` (docs/systems/websocket.md) and
 * refetches the space's detail, which carries their permissions, the channels
 * they can see, the roles and the member list. `affectedUserIds` are the
 * members whose own permissions may have changed; each is also sent the voice
 * state they can see now (`announceSpaceAccessChange`). Voice permissions are
 * re-checked here too, since a role can carry SPEAK or STREAM.
 */
function announceAccessChange(spaceId: string, affectedUserIds: readonly string[]): void {
  connectionManager.announceSpaceAccessChange(spaceId, affectedUserIds);
  checkVoicePermissions(spaceId);
}

/** The members whose permissions a change to `roleId` reaches: its holders, or everyone for @everyone. */
function membersHoldingRole(spaceId: string, roleId: string): string[] {
  const db = getDb();
  if (roleId === spaceId) {
    return db.select({ userId: schema.spaceMembers.userId }).from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.spaceId, spaceId)).all().map((m) => m.userId);
  }
  return db.select({ userId: schema.memberRoles.userId }).from(schema.memberRoles)
    .where(and(eq(schema.memberRoles.spaceId, spaceId), eq(schema.memberRoles.roleId, roleId)))
    .all().map((m) => m.userId);
}

type RoleChangeRefusal = {
  status: 400 | 403 | 404;
  code: 'missing_permission' | 'cannot_change_own_roles' | 'space_owner_only' | 'member_not_found' | 'role_not_in_space' | 'everyone_role_not_assignable' | 'role_hierarchy' | HeldBitsRefusal;
  details?: Record<string, string>;
};

/**
 * Held-bits rule for handing out a role (permissions.md, "Held-bits rule"):
 * giving a member a role gives them its bits, so the actor must hold every
 * one of them. Taking a role away is governed by the hierarchy alone.
 */
function roleGrantRefusal(spaceId: string, actorId: string, rolePermissions: string | null): HeldBitsRefusal | null {
  return roleBitsChangeRefusal(computePermissions(actorId, spaceId), 0n, stringToPermissions(rolePermissions));
}

/**
 * The checks shared by the two single-role routes (add one role to a member,
 * take one away). They match what PATCH /members/:uid enforces for a whole
 * role set: MANAGE_ROLES, not one's own roles, not the owner's, a member of
 * this space, a role of this space other than @everyone, a member ranked
 * below the actor, a role below the actor's top role and, when adding, a
 * role whose bits the actor holds.
 */
function checkSingleRoleChange(
  spaceId: string,
  actorId: string,
  targetId: string,
  roleId: string,
  change: 'add' | 'remove',
): RoleChangeRefusal | null {
  const db = getDb();
  if (!hasPermission(actorId, spaceId, PermissionBits.MANAGE_ROLES)) {
    return { status: 403, code: 'missing_permission', details: { permission: 'MANAGE_ROLES' } };
  }
  if (targetId === actorId) return { status: 400, code: 'cannot_change_own_roles' };
  if (isSpaceOwner(spaceId, targetId)) return { status: 403, code: 'space_owner_only' };
  if (!isMember(spaceId, targetId)) return { status: 404, code: 'member_not_found' };
  const role = typeof roleId === 'string'
    ? db.select().from(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, spaceId))).get()
    : undefined;
  if (!role) return { status: 400, code: 'role_not_in_space', details: { roleId: String(roleId) } };
  if (role.id === spaceId) return { status: 400, code: 'everyone_role_not_assignable' };
  const actor = getHierarchyStanding(spaceId, actorId);
  if (!canActOnMember(actor, getHierarchyStanding(spaceId, targetId)) || !canManageRoleAt(actor, role.position ?? 0)) {
    return { status: 403, code: 'role_hierarchy' };
  }
  if (change === 'add') {
    const refusal = roleGrantRefusal(spaceId, actorId, role.permissions);
    if (refusal) return { status: 403, code: refusal };
  }
  return null;
}

export async function spaceRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/spaces - Create a new server
  app.post<{ Body: CreateSpaceRequest }>('/api/spaces', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { name, icon, banner, avatarColor, visibility, description } = request.body;

    if (!name || typeof name !== 'string') {
      return sendError(reply, 400, 'space_name_required');
    }

    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 100) {
      return sendError(reply, 400, 'space_name_length', { min: 1, max: 100 });
    }

    // Validate visibility
    const validVisibilities = ['public', 'request', 'private'];
    const safeVisibility = visibility && validVisibilities.includes(visibility) ? visibility : 'private';

    // Validate description
    const safeDescription = description ? description.trim().slice(0, 200) || null : null;

    // Validate avatarColor — assign random if not provided
    const safeAvatarColor = avatarColor && (AVATAR_COLORS as readonly string[]).includes(avatarColor)
      ? avatarColor
      : AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

    const db = getDb();
    const spaceId = generateSnowflake();
    const textCategoryId = generateSnowflake();
    const voiceCategoryId = generateSnowflake();
    const channelId = generateSnowflake();
    const voiceChannelId = generateSnowflake();
    const now = Date.now();
    const inviteCode = generateInviteCode();

    // Create server, owner membership, default categories + channels, and @everyone role atomically
    db.transaction((tx) => {
      tx.insert(schema.spaces).values({
        id: spaceId,
        name: trimmedName,
        icon: icon ?? null,
        banner: banner ?? null,
        avatarColor: safeAvatarColor,
        ownerId: request.userId,
        inviteCode,
        visibility: safeVisibility,
        description: safeDescription,
        createdAt: now,
      }).run();

      tx.insert(schema.spaceMembers).values({
        spaceId,
        userId: request.userId,
        joinedAt: now,
      }).run();

      // Default categories
      tx.insert(schema.channelCategories).values({
        id: textCategoryId,
        spaceId,
        name: 'text-channels',
        position: 0,
        createdAt: now,
      }).run();

      tx.insert(schema.channelCategories).values({
        id: voiceCategoryId,
        spaceId,
        name: 'voice-channels',
        position: 1,
        createdAt: now,
      }).run();

      // Default text channel in text-channels category
      tx.insert(schema.channels).values({
        id: channelId,
        spaceId,
        name: 'general',
        type: 'text',
        position: 0,
        categoryId: textCategoryId,
        createdAt: now,
      }).run();

      // Default voice channel in voice-channels category
      tx.insert(schema.channels).values({
        id: voiceChannelId,
        spaceId,
        name: 'voice',
        type: 'voice',
        position: 0,
        categoryId: voiceCategoryId,
        createdAt: now,
      }).run();

      // Auto-create @everyone role (id = spaceId)
      tx.insert(schema.roles).values({
        id: spaceId,
        spaceId,
        name: '@everyone',
        color: '#b9bbbe',
        position: 0,
        permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
        createdAt: now,
      }).run();
    });

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();
    if (!server) {
      return sendError(reply, 500, 'space_create_failed');
    }

    // Register the creator in connectionManager so they receive WS broadcasts for this space
    connectionManager.addUserSpace(request.userId, spaceId);

    // Clean up attachment records for icon/banner — reference is now in spaces table
    if (icon && typeof icon === 'string' && icon.includes('/api/uploads/')) {
      deleteAttachmentByFilename(icon);
    }
    if (banner && typeof banner === 'string' && banner.includes('/api/uploads/')) {
      deleteAttachmentByFilename(banner);
    }

    // Resize profile images to optimal dimensions
    if (icon && typeof icon === 'string' && !icon.startsWith('http')) {
      const filePath = path.join(config.uploadDir, path.basename(icon));
      await resizeProfileImage(filePath, 'icon');
    }
    if (banner && typeof banner === 'string' && !banner.startsWith('http')) {
      const filePath = path.join(config.uploadDir, path.basename(banner));
      await resizeProfileImage(filePath, 'banner');
    }

    return reply.code(201).send(rowToSpace(server));
  });

  // GET /api/spaces - List user's servers
  app.get('/api/spaces', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();

    const memberships = db.select()
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.userId, request.userId))
      .all();

    if (memberships.length === 0) {
      return reply.code(200).send([]);
    }

    const spaceIds = memberships.map(m => m.spaceId);
    const servers = db.select()
      .from(schema.spaces)
      .where(inArray(schema.spaces.id, spaceIds))
      .all();

    return reply.code(200).send(servers.map(rowToSpace));
  });

  // GET /api/spaces/:id - Get server detail with channels and members
  app.get<{ Params: { id: string } }>('/api/spaces/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!isMember(id, request.userId)) {
      return sendError(reply, 403, 'not_space_member');
    }

    const channels = db.select()
      .from(schema.channels)
      .where(eq(schema.channels.spaceId, id))
      .all();

    const roles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.spaceId, id))
      .orderBy(schema.roles.position)
      .all();

    const memberRows = db.select()
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.spaceId, id))
      .all();

    const memberUserIds = memberRows.map(m => m.userId);
    const users = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const userMap = new Map(users.map(u => [u.id, u]));

    const memberRoleRows = db.select()
      .from(schema.memberRoles)
      .where(eq(schema.memberRoles.spaceId, id))
      .all();

    const members: MemberWithUser[] = memberRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;

        const assignedRoleIds = new Set(memberRoleRows
          .filter(mr => mr.userId === m.userId)
          .map(mr => mr.roleId));

        return {
          spaceId: m.spaceId,
          userId: m.userId,
          nickname: m.nickname,
          joinedAt: m.joinedAt,
          user: sanitizeUser(user),
          roles: memberRolesView(roles, assignedRoleIds),
        };
      })
      .filter((m): m is MemberWithUser => m !== null);

    // Fetch categories for this space
    const categoryRows = db.select()
      .from(schema.channelCategories)
      .where(eq(schema.channelCategories.spaceId, id))
      .all();

    // Batch-fetch the @everyone category overrides to determine isPrivate
    // (`isHiddenFromEveryone`, read per category).
    const catEveryoneOverrides = db.select().from(schema.categoryOverrides)
      .where(and(
        eq(schema.categoryOverrides.targetType, 'role'),
        eq(schema.categoryOverrides.targetId, id),
      ))
      .all();
    const privateCategoryIds = idsHiddenFromEveryone(catEveryoneOverrides, (o) => o.categoryId, () => id);

    const categories: ChannelCategory[] = categoryRows.map(c => ({
      id: c.id,
      spaceId: c.spaceId,
      name: c.name,
      position: c.position ?? 0,
      isPrivate: privateCategoryIds.has(c.id),
      createdAt: c.createdAt,
    }));

    // Compute space-level permissions for the requesting user
    const spacePerms = computePermissions(request.userId, id);

    // Batch-fetch the @everyone channel overrides (role = spaceId) to determine
    // isPrivate (`isHiddenFromEveryone`, read per channel).
    const everyoneOverrides = db.select().from(schema.channelOverrides)
      .where(and(
        eq(schema.channelOverrides.targetType, 'role'),
        eq(schema.channelOverrides.targetId, id),
      ))
      .all();
    const privateChannelIds = idsHiddenFromEveryone(everyoneOverrides, (o) => o.channelId, () => id);

    // Filter channels by VIEW_CHANNEL permission and attach per-channel myPermissions
    const visibleChannels: (Channel & { isPrivate: boolean; myPermissions: string })[] = [];
    for (const ch of channels) {
      const perms = computePermissions(request.userId, id, ch.id);
      if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
        visibleChannels.push({
          ...rowToChannel(ch),
          isPrivate: privateChannelIds.has(ch.id),
          myPermissions: permissionsToString(perms),
        });
      }
    }

    const result: SpaceWithChannelsAndMembers = {
      ...rowToSpace(server),
      channels: visibleChannels,
      categories,
      members,
      roles: rolesForViewer(roles, spacePerms),
      myPermissions: permissionsToString(spacePerms),
    };

    return reply.code(200).send(result);
  });

  // PATCH /api/spaces/:id - Update server (owner only)
  app.patch<{ Params: { id: string }; Body: UpdateSpaceRequest }>('/api/spaces/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, icon, banner, avatarColor, visibility, description, directoryListed } = request.body;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_SPACE)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_SPACE' });
    }

    const updates: Partial<typeof schema.spaces.$inferInsert> = {};

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName.length < 1 || trimmedName.length > 100) {
        return sendError(reply, 400, 'space_name_length', { min: 1, max: 100 });
      }
      updates.name = trimmedName;
    }

    // Track old files for cleanup after update
    const oldIcon = server.icon;
    const oldBanner = server.banner;

    if (icon !== undefined) {
      updates.icon = icon || null;
    }

    if (banner !== undefined) {
      updates.banner = banner || null;
    }

    if (avatarColor !== undefined) {
      if (avatarColor === '') {
        updates.avatarColor = null;
      } else if ((AVATAR_COLORS as readonly string[]).includes(avatarColor)) {
        updates.avatarColor = avatarColor;
      } else {
        return sendError(reply, 400, 'avatar_color_invalid');
      }
    }

    if (visibility !== undefined) {
      const validVisibilities = ['public', 'request', 'private'];
      if (!validVisibilities.includes(visibility)) {
        return sendError(reply, 400, 'space_visibility_invalid');
      }
      updates.visibility = visibility;
    }

    if (description !== undefined) {
      const trimmed = description.trim().slice(0, 200);
      updates.description = trimmed || null;
    }

    // Directory listing follows the same MANAGE_SPACE rule as visibility. A
    // private space is never listed: asking for it is refused, and a listed
    // space going private is unlisted in the same write (spec section 4).
    const resultingVisibility = updates.visibility ?? server.visibility ?? 'private';
    if (directoryListed !== undefined) {
      if (typeof directoryListed !== 'boolean') {
        return sendError(reply, 400, 'field_not_boolean', { field: 'directoryListed' });
      }
      if (directoryListed && resultingVisibility === 'private') {
        return sendError(reply, 400, 'directory_private_space');
      }
      updates.directoryListed = directoryListed ? 1 : 0;
    }
    if (resultingVisibility === 'private' && server.directoryListed === 1) {
      updates.directoryListed = 0;
    }

    if (Object.keys(updates).length === 0) {
      return sendError(reply, 400, 'no_fields_to_update');
    }

    db.update(schema.spaces).set(updates).where(eq(schema.spaces.id, id)).run();

    const listedAfter = (updates.directoryListed ?? server.directoryListed) === 1;
    const listingChanged = updates.directoryListed !== undefined && updates.directoryListed !== server.directoryListed;
    const servedFieldChanged = DIRECTORY_SPACE_FIELDS.some(
      (field) => updates[field] !== undefined && updates[field] !== server[field],
    );
    if (listingChanged || (listedAfter && servedFieldChanged)) {
      markDirectoryDirty(getRawDb());
    }

    // Clean up old icon/banner files that were replaced
    if (icon !== undefined && oldIcon && oldIcon !== (icon || null) && !oldIcon.startsWith('http')) {
      deleteUploadFile(oldIcon);
      deleteAttachmentByFilename(oldIcon);
    }
    if (banner !== undefined && oldBanner && oldBanner !== (banner || null) && !oldBanner.startsWith('http')) {
      deleteUploadFile(oldBanner);
      deleteAttachmentByFilename(oldBanner);
    }
    // Clean up attachment records for newly-set profile images — the reference
    // now lives in the spaces table, so the attachment record is unnecessary
    if (icon && typeof icon === 'string' && icon.includes('/api/uploads/')) {
      deleteAttachmentByFilename(icon);
    }
    if (banner && typeof banner === 'string' && banner.includes('/api/uploads/')) {
      deleteAttachmentByFilename(banner);
    }

    // Resize profile images to optimal dimensions
    if (icon && typeof icon === 'string' && !icon.startsWith('http')) {
      const filePath = path.join(config.uploadDir, path.basename(icon));
      await resizeProfileImage(filePath, 'icon');
    }
    if (banner && typeof banner === 'string' && !banner.startsWith('http')) {
      const filePath = path.join(config.uploadDir, path.basename(banner));
      await resizeProfileImage(filePath, 'banner');
    }

    const updated = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!updated) {
      return sendError(reply, 500, 'space_update_failed');
    }

    const spaceData = rowToSpace(updated);

    // Broadcast space_updated to all space members
    connectionManager.sendToSpace(id, {
      type: 'space_updated',
      space: spaceData,
    });

    return reply.code(200).send(spaceData);
  });

  // DELETE /api/spaces/:id - Delete server (owner only)
  app.delete<{ Params: { id: string } }>('/api/spaces/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!isSpaceOwner(id, request.userId)) {
      return sendError(reply, 403, 'space_owner_only');
    }

    // Collect all attachment files before cascade-deleting DB records
    const channelIds = db.select({ id: schema.channels.id })
      .from(schema.channels).where(eq(schema.channels.spaceId, id)).all().map(c => c.id);

    let attachmentRows: { filename: string }[] = [];
    if (channelIds.length > 0) {
      const messageIds = db.select({ id: schema.messages.id })
        .from(schema.messages).where(inArray(schema.messages.channelId, channelIds)).all().map(m => m.id);
      if (messageIds.length > 0) {
        attachmentRows = db.select({ filename: schema.attachments.filename })
          .from(schema.attachments).where(inArray(schema.attachments.messageId, messageIds)).all();
      }
    }

    // Capture space icon/banner before deletion
    const spaceIcon = server.icon;
    const spaceBanner = server.banner;

    // Delete all channels (messages cascade), members, folder refs, read states, then space atomically
    db.transaction((tx) => {
      // Clean up read_states for all channels in this space (no FK cascade — channelId is plain text)
      if (channelIds.length > 0) {
        tx.delete(schema.readStates).where(inArray(schema.readStates.channelId, channelIds)).run();
      }
      tx.delete(schema.channels).where(eq(schema.channels.spaceId, id)).run();
      tx.delete(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, id)).run();
      tx.delete(schema.spaceFolderMembers).where(eq(schema.spaceFolderMembers.spaceId, id)).run();
      tx.delete(schema.spaces).where(eq(schema.spaces.id, id)).run();
    });

    // A listed space just left the served document.
    if (server.directoryListed === 1) {
      markDirectoryDirty(getRawDb());
    }

    // Clean up all attachment files from disk
    deleteAttachmentFiles(attachmentRows);

    // Clean up space icon/banner files
    if (spaceIcon && !spaceIcon.startsWith('http')) deleteUploadFile(spaceIcon);
    if (spaceBanner && !spaceBanner.startsWith('http')) deleteUploadFile(spaceBanner);

    return reply.code(200).send({ success: true });
  });

  // POST /api/spaces/:id/invite - Generate invite code (admin+)
  app.post<{ Params: { id: string } }>('/api/spaces/:id/invite', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!hasPermission(request.userId, id, PermissionBits.CREATE_INVITE)) {
      // Owners and instance admins always pass hasPermission, so anyone who lands
      // here is either a non-member or a member without CREATE_INVITE. Give the
      // non-member a clearer "go join first" message instead of a permission error.
      if (!isMember(id, request.userId)) {
        return sendError(reply, 403, 'not_space_member');
      }
      return sendError(reply, 403, 'missing_permission', { permission: 'CREATE_INVITE' });
    }

    // Request-only spaces are approval-gated and never joinable by invite code
    // (see the join endpoints), so they have no usable invite links. Refuse to
    // hand one out rather than mint a code that would dead-end at the join guard.
    if (server.visibility === 'request') {
      return sendError(reply, 403, 'space_uses_join_requests');
    }

    // Return existing invite code if one exists, otherwise generate a new one
    if (server.inviteCode) {
      return reply.code(200).send({ inviteCode: server.inviteCode });
    }

    const inviteCode = generateInviteCode();
    db.update(schema.spaces).set({ inviteCode }).where(eq(schema.spaces.id, id)).run();

    return reply.code(200).send({ inviteCode });
  });

  // POST /api/spaces/:id/join - Join server by invite code
  app.post<{ Params: { id: string }; Body: JoinSpaceRequest }>('/api/spaces/:id/join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { inviteCode } = request.body;

    if (!inviteCode || typeof inviteCode !== 'string') {
      return sendError(reply, 400, 'invite_code_required');
    }

    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (server.inviteCode !== inviteCode) {
      return sendError(reply, 400, 'invite_not_found');
    }

    if (isBanned(id, request.userId)) {
      return sendError(reply, 403, 'user_banned');
    }

    if (isMember(id, request.userId)) {
      return sendError(reply, 409, 'already_member');
    }

    // Request-only spaces are gated by manager approval: entry must go through
    // POST /request-join + approval, never a bearer invite code. (Private spaces
    // remain invite-joinable — that is their only entry path; public too.)
    if (server.visibility === 'request') {
      return sendError(reply, 403, 'join_request_required');
    }

    const now = Date.now();
    db.insert(schema.spaceMembers).values({
      spaceId: id,
      userId: request.userId,
      joinedAt: now,
    }).run();

    // Register the user in connectionManager so they receive WS broadcasts for this server
    connectionManager.addUserSpace(request.userId, id);

    // Broadcast member_joined to existing server members
    const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (joiningUser) {
      const memberPayload: MemberWithUser = {
        spaceId: id,
        userId: request.userId,
        nickname: null,
        joinedAt: now,
        user: sanitizeUser(joiningUser),
        roles: [],
      };
      connectionManager.sendToSpace(id, {
        type: 'member_joined',
        spaceId: id,
        member: memberPayload,
      });
    }

    return reply.code(200).send(rowToSpace(server));
  });

  // POST /api/spaces/join - Join server by invite code (no server ID needed)
  app.post<{ Body: JoinSpaceRequest }>('/api/spaces/join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { inviteCode } = request.body;

    if (!inviteCode || typeof inviteCode !== 'string') {
      return sendError(reply, 400, 'invite_code_required');
    }

    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.inviteCode, inviteCode)).get();
    if (!server) {
      return sendError(reply, 404, 'invite_not_found');
    }

    if (isBanned(server.id, request.userId)) {
      return sendError(reply, 403, 'user_banned');
    }

    if (isMember(server.id, request.userId)) {
      return sendError(reply, 409, 'already_member');
    }

    // Request-only spaces are gated by manager approval (see POST /:id/join).
    if (server.visibility === 'request') {
      return sendError(reply, 403, 'join_request_required');
    }

    const now = Date.now();
    db.insert(schema.spaceMembers).values({
      spaceId: server.id,
      userId: request.userId,
      joinedAt: now,
    }).run();

    // Register the user in connectionManager so they receive WS broadcasts for this server
    connectionManager.addUserSpace(request.userId, server.id);

    // Broadcast member_joined to existing server members
    const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (joiningUser) {
      const memberPayload: MemberWithUser = {
        spaceId: server.id,
        userId: request.userId,
        nickname: null,
        joinedAt: now,
        user: sanitizeUser(joiningUser),
        roles: [],
      };
      connectionManager.sendToSpace(server.id, {
        type: 'member_joined',
        spaceId: server.id,
        member: memberPayload,
      });
    }

    return reply.code(200).send(rowToSpace(server));
  });

  // GET /api/spaces/:id/members - List server members
  app.get<{ Params: { id: string } }>('/api/spaces/:id/members', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!isMember(id, request.userId)) {
      return sendError(reply, 403, 'not_space_member');
    }

    const memberRows = db.select()
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.spaceId, id))
      .all();

    const memberUserIds = memberRows.map(m => m.userId);
    const users = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const userMap = new Map(users.map(u => [u.id, u]));

    const roles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.spaceId, id))
      .orderBy(schema.roles.position)
      .all();

    const memberRoleRows = db.select()
      .from(schema.memberRoles)
      .where(eq(schema.memberRoles.spaceId, id))
      .all();

    const members: MemberWithUser[] = memberRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;

        const assignedRoleIds = new Set(memberRoleRows
          .filter(mr => mr.userId === m.userId)
          .map(mr => mr.roleId));

        return {
          spaceId: m.spaceId,
          userId: m.userId,
          nickname: m.nickname,
          joinedAt: m.joinedAt,
          user: sanitizeUser(user),
          roles: memberRolesView(roles, assignedRoleIds),
        };
      })
      .filter((m): m is MemberWithUser => m !== null);

    return reply.code(200).send(members);
  });

  // PATCH /api/spaces/:id/members/:uid - Update member roles
  app.patch<{ Params: { id: string; uid: string }; Body: UpdateMemberRequest }>('/api/spaces/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { roleIds } = request.body;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    if (uid === request.userId) {
      return sendError(reply, 400, 'cannot_change_own_roles');
    }

    // A set of role ids: each a string, none twice. The whole list replaces
    // the member's roles, and the table holds each role once per member.
    if (!Array.isArray(roleIds)
      || !roleIds.every((roleId): roleId is string => typeof roleId === 'string')
      || new Set(roleIds).size !== roleIds.length) {
      return sendError(reply, 400, 'role_ids_invalid');
    }

    // Cannot modify the server owner's roles unless you are the owner
    if (isSpaceOwner(id, uid) && !isSpaceOwner(id, request.userId)) {
      return sendError(reply, 403, 'space_owner_only');
    }

    const member = db.select()
      .from(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .get();

    if (!member) {
      return sendError(reply, 404, 'member_not_found');
    }

    // Validate all roleIds belong to this server and are not @everyone
    const spaceRoles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.spaceId, id))
      .all();
    const spaceRolePositions = new Map(spaceRoles.map(r => [r.id, r.position ?? 0]));

    for (const roleId of roleIds) {
      if (!spaceRolePositions.has(roleId)) {
        return sendError(reply, 400, 'role_not_in_space', { roleId });
      }
      if (roleId === id) {
        return sendError(reply, 400, 'everyone_role_not_assignable');
      }
    }

    // Role hierarchy: the member must rank below the actor, and every role
    // this request adds or removes must sit below the actor's top role.
    const actorStanding = getHierarchyStanding(id, request.userId);
    if (!canActOnMember(actorStanding, getHierarchyStanding(id, uid))) {
      return sendError(reply, 403, 'role_hierarchy');
    }
    const currentRoleIds = new Set(
      db.select({ roleId: schema.memberRoles.roleId })
        .from(schema.memberRoles)
        .where(and(eq(schema.memberRoles.spaceId, id), eq(schema.memberRoles.userId, uid)))
        .all()
        .map(r => r.roleId),
    );
    const requestedRoleIds = new Set(roleIds);
    const changedRoleIds = [
      ...roleIds.filter(r => !currentRoleIds.has(r)),
      ...[...currentRoleIds].filter(r => !requestedRoleIds.has(r)),
    ];
    for (const roleId of changedRoleIds) {
      if (!canManageRoleAt(actorStanding, spaceRolePositions.get(roleId) ?? 0)) {
        return sendError(reply, 403, 'role_hierarchy');
      }
    }
    // Held-bits rule: a role this request adds must carry only bits the actor holds.
    for (const roleId of roleIds.filter(r => !currentRoleIds.has(r))) {
      const refusal = roleGrantRefusal(id, request.userId, spaceRoles.find(r => r.id === roleId)?.permissions ?? null);
      if (refusal) {
        return sendError(reply, 403, refusal);
      }
    }

    // Atomically replace member's role assignments
    db.transaction((tx) => {
      // Remove all existing role assignments for this member in this server
      tx.delete(schema.memberRoles)
        .where(and(
          eq(schema.memberRoles.spaceId, id),
          eq(schema.memberRoles.userId, uid),
        ))
        .run();

      // Insert new role assignments
      for (const roleId of roleIds) {
        tx.insert(schema.memberRoles).values({
          spaceId: id,
          userId: uid,
          roleId,
        }).run();
      }
    });

    announceAccessChange(id, [uid]);

    // Build response with populated roles
    const updatedMember = db.select()
      .from(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .get();

    if (!updatedMember) {
      return sendError(reply, 500, 'member_update_failed');
    }

    const user = db.select().from(schema.users).where(eq(schema.users.id, uid)).get();
    if (!user) {
      return sendError(reply, 500, 'user_not_found');
    }

    const updatedRoleRows = db.select()
      .from(schema.memberRoles)
      .where(and(
        eq(schema.memberRoles.spaceId, id),
        eq(schema.memberRoles.userId, uid),
      ))
      .all();

    const updatedRoleIds = new Set(updatedRoleRows.map(r => r.roleId));
    const allRoles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.spaceId, id))
      .orderBy(schema.roles.position)
      .all();

    const result: MemberWithUser = {
      spaceId: updatedMember.spaceId,
      userId: updatedMember.userId,
      nickname: updatedMember.nickname,
      joinedAt: updatedMember.joinedAt,
      user: sanitizeUser(user),
      roles: memberRolesView(allRoles, updatedRoleIds),
    };

    return reply.code(200).send(result);
  });

  // DELETE /api/spaces/:id/members/:uid - Kick member (owner) or leave (self)
  app.delete<{ Params: { id: string; uid: string } }>('/api/spaces/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    const isSelf = uid === request.userId;
    const isOwnerUser = isSpaceOwner(id, request.userId);
    const canKick = hasPermission(request.userId, id, PermissionBits.KICK_MEMBERS);

    if (!isSelf && !canKick) {
      return sendError(reply, 403, 'missing_permission', { permission: 'KICK_MEMBERS' });
    }

    // Owner cannot leave their own server - they must delete it
    if (isSelf && isOwnerUser) {
      return sendError(reply, 400, 'space_owner_cannot_leave');
    }

    const member = db.select()
      .from(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .get();

    if (!member) {
      return sendError(reply, 404, 'member_not_found');
    }

    // Cannot kick the owner
    if (isSpaceOwner(id, uid)) {
      return sendError(reply, 400, 'cannot_target_owner');
    }

    // Kicking someone else needs a higher top role than theirs
    if (!isSelf && !canActOnMemberInSpace(id, request.userId, uid)) {
      return sendError(reply, 403, 'role_hierarchy');
    }

    db.delete(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .run();

    // Clean up any voice restrictions for the removed member
    db.delete(schema.voiceRestrictions).where(
      and(
        eq(schema.voiceRestrictions.spaceId, id),
        eq(schema.voiceRestrictions.userId, uid),
      )
    ).run();

    // Clean up read_states for the departing user in this space's channels
    const spaceChannelIds = db.select({ id: schema.channels.id })
      .from(schema.channels).where(eq(schema.channels.spaceId, id)).all().map(c => c.id);
    if (spaceChannelIds.length > 0) {
      db.delete(schema.readStates).where(and(
        eq(schema.readStates.userId, uid),
        inArray(schema.readStates.channelId, spaceChannelIds),
      )).run();
    }

    // Broadcast member_left event
    connectionManager.sendToSpace(id, {
      type: 'member_left',
      spaceId: id,
      userId: uid,
    });

    return reply.code(200).send({ success: true });
  });

  // Role Management
  
  // POST /api/spaces/:id/roles - Create a new role
  app.post<{ Params: { id: string }; Body: { name: string; color?: string; permissions?: string } }>('/api/spaces/:id/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, color, permissions } = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    // A new role can only carry bits its creator holds (held-bits rule,
    // permissions.md). Without this a MANAGE_ROLES holder could create an
    // ADMINISTRATOR role below their own and give it to anyone they outrank.
    const actorPerms = computePermissions(request.userId, id);
    let permStr: string;
    if (permissions !== undefined && permissions !== null) {
      const requested = parsePermissionString(permissions);
      if (requested === null) {
        return sendError(reply, 400, 'permissions_invalid');
      }
      const refusal = roleBitsChangeRefusal(actorPerms, 0n, requested);
      if (refusal) {
        return sendError(reply, 403, refusal);
      }
      permStr = permissionsToString(requested);
    } else {
      // Default to the @everyone baseline so new roles start functional,
      // limited to the bits the creator holds.
      permStr = permissionsToString(DEFAULT_EVERYONE_PERMISSIONS & actorPerms);
    }

    // Trim and validate name
    const roleName = (name || 'new role').trim() || 'new role';

    // Check for case-insensitive duplicate name within the space
    const rawDb = getRawDb();
    const duplicate = rawDb.prepare(
      'SELECT id FROM roles WHERE space_id = ? AND name COLLATE NOCASE = ?'
    ).get(id, roleName);
    if (duplicate) {
      return sendError(reply, 409, 'role_name_taken');
    }

    // A new role starts at the bottom, just above @everyone, so the actor
    // must be able to manage a role there.
    if (!canManageRoleInSpace(id, request.userId, 1)) {
      return sendError(reply, 403, 'role_hierarchy');
    }

    const roleId = generateSnowflake();
    db.insert(schema.roles).values({
      id: roleId,
      spaceId: id,
      name: roleName,
      color: color || '#b9bbbe',
      // Position 0 ties with nothing but @everyone's slot; the normalisation
      // below places the newest role last, at 1, and moves the others up.
      position: 0,
      permissions: permStr,
      createdAt: Date.now(),
    }).run();
    normalizeRolePositions(rawDb, id);

    const role = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
    if (!role) {
      return sendError(reply, 500, 'internal_error');
    }

    // A new role has no holders yet, so nobody's own access changed.
    announceAccessChange(id, []);

    return reply.code(201).send(roleView(role, viewerReadsPermissionData(computePermissions(request.userId, id))));
  });

  // PATCH /api/spaces/:id/roles/:roleId - Update a role
  app.patch<{ Params: { id: string; roleId: string }; Body: { name?: string; color?: string; position?: number; above?: unknown; below?: unknown; permissions?: string; permissionsVersion?: unknown } }>('/api/spaces/:id/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, roleId } = request.params;
    const { name, color, permissions, above, below, permissionsVersion } = request.body;
    let position = request.body.position;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    const role = db.select().from(schema.roles)
      .where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id)))
      .get();
    if (!role) {
      return sendError(reply, 404, 'role_not_in_space', { roleId });
    }

    // Only roles below the actor's top role can be edited or moved, and only
    // to a position that is still below it.
    const actorStanding = getHierarchyStanding(id, request.userId);
    if (!canManageRoleAt(actorStanding, role.position ?? 0)) {
      return sendError(reply, 403, 'role_hierarchy');
    }
    // A move by anchor (`above` or `below` another role) lands the role next
    // to that role in the order as it is now, so it does what the mover's list
    // showed even when that list is out of date; the request's `position`,
    // which clients send too for servers that do not read the anchor, is
    // ignored then (permissions.md, "Setting the order").
    if (above !== undefined || below !== undefined) {
      const side = above !== undefined ? 'above' : 'below';
      const anchorId = above ?? below;
      if (roleId === id || (above !== undefined && below !== undefined) || typeof anchorId !== 'string') {
        return sendError(reply, 400, 'validation_failed');
      }
      const anchor = db.select({ id: schema.roles.id }).from(schema.roles)
        .where(and(eq(schema.roles.id, anchorId), eq(schema.roles.spaceId, id)))
        .get();
      if (!anchor) {
        return sendError(reply, 400, 'role_not_in_space', { roleId: anchorId });
      }
      const placed = positionNextTo(getRawDb(), id, roleId, anchorId, side);
      if (placed === null) {
        return sendError(reply, 400, 'validation_failed');
      }
      position = placed;
    }
    if (position !== undefined) {
      // @everyone is always at 0, and positions count from 1.
      if (roleId === id || !Number.isInteger(position) || position < 1) {
        return sendError(reply, 400, 'validation_failed');
      }
      if (!canManageRoleAt(actorStanding, position)) {
        return sendError(reply, 403, 'role_hierarchy');
      }
    }

    const updates: Partial<typeof schema.roles.$inferInsert> = {};
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        return sendError(reply, 400, 'role_name_required');
      }
      // Check for case-insensitive duplicate name within the space
      const rawDb = getRawDb();
      const duplicate = rawDb.prepare(
        'SELECT id FROM roles WHERE space_id = ? AND name COLLATE NOCASE = ? AND id != ?'
      ).get(id, trimmed, roleId);
      if (duplicate) {
        return sendError(reply, 409, 'role_name_taken');
      }
      updates.name = trimmed;
    }
    if (color !== undefined) updates.color = color;

    if (permissions !== undefined) {
      const requested = parsePermissionString(permissions);
      if (requested === null) {
        return sendError(reply, 400, 'permissions_invalid');
      }
      // Concurrent edits (permissions.md): a value saved from an outdated copy
      // of the role is refused. Without `permissionsVersion` (a client from
      // before the check) the write is not compared, as before.
      if (permissionsVersion !== undefined) {
        if (typeof permissionsVersion !== 'string' || permissionsVersion.length === 0) {
          return sendError(reply, 400, 'validation_failed');
        }
        if (rolePermissionsVersion(role.permissions) !== permissionsVersion) {
          return sendError(reply, 409, 'role_permissions_conflict');
        }
      }
      // Held-bits rule: only bits the actor holds may be switched, on or off.
      const refusal = roleBitsChangeRefusal(
        computePermissions(request.userId, id),
        stringToPermissions(role.permissions),
        requested,
      );
      if (refusal) {
        return sendError(reply, 403, refusal);
      }
      updates.permissions = permissionsToString(requested);
    }

    if (Object.keys(updates).length === 0 && position === undefined) {
      return sendError(reply, 400, 'no_fields_to_update');
    }

    if (Object.keys(updates).length > 0) {
      db.update(schema.roles).set(updates).where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id))).run();
    }
    // A move renumbers the other roles too, so positions stay distinct.
    if (position !== undefined) {
      moveRoleToPosition(getRawDb(), id, roleId, position);
    }
    const updated = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
    if (!updated) {
      return sendError(reply, 404, 'role_not_in_space', { roleId });
    }

    announceAccessChange(id, membersHoldingRole(id, roleId));

    // The actor may have just switched off their own MANAGE_ROLES (a role
    // below their top role can carry it), so the answer is shaped for what
    // they hold now.
    return reply.code(200).send(roleView(updated, viewerReadsPermissionData(computePermissions(request.userId, id))));
  });

  // DELETE /api/spaces/:id/roles/:roleId - Delete a role
  app.delete<{ Params: { id: string; roleId: string } }>('/api/spaces/:id/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, roleId } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    // Cannot delete @everyone role
    if (roleId === id) {
      return sendError(reply, 400, 'everyone_role_not_deletable');
    }

    // The overrides below are keyed by role id alone, so the role has to be
    // proven to belong to this space before its id is used to delete them.
    const role = db.select().from(schema.roles)
      .where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id)))
      .get();
    if (!role) {
      return sendError(reply, 404, 'role_not_in_space', { roleId });
    }

    if (!canManageRoleInSpace(id, request.userId, role.position ?? 0)) {
      return sendError(reply, 403, 'role_hierarchy');
    }

    // Held-bits rule: deleting a role switches every bit of it off, the same
    // change as a PATCH to no bits, so each bit must be held. Who holds the
    // role (members ranked above the actor included) does not matter: the
    // hierarchy decides who may change a role, not who the change reaches.
    const deleteRefusal = roleBitsChangeRefusal(computePermissions(request.userId, id), stringToPermissions(role.permissions), 0n);
    if (deleteRefusal) {
      return sendError(reply, 403, deleteRefusal);
    }

    // Its holders, read before the delete takes their member_roles rows with it.
    const holders = membersHoldingRole(id, roleId);

    // Overrides name their target without a foreign key, so they would
    // outlive the role: invisible in the editor and impossible to remove.
    db.transaction((tx) => {
      tx.delete(schema.channelOverrides).where(
        and(eq(schema.channelOverrides.targetType, 'role'), eq(schema.channelOverrides.targetId, roleId))
      ).run();
      tx.delete(schema.categoryOverrides).where(
        and(eq(schema.categoryOverrides.targetType, 'role'), eq(schema.categoryOverrides.targetId, roleId))
      ).run();
      tx.delete(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id))).run();
    });
    normalizeRolePositions(getRawDb(), id);

    announceAccessChange(id, holders);

    return reply.code(200).send({ success: true });
  });

  // POST /api/spaces/:id/members/:uid/roles - Add role to member
  app.post<{ Params: { id: string; uid: string }; Body: { roleId: string } }>('/api/spaces/:id/members/:uid/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { roleId } = request.body;
    const db = getDb();

    const refusal = checkSingleRoleChange(id, request.userId, uid, roleId, 'add');
    if (refusal) return sendError(reply, refusal.status, refusal.code, refusal.details);

    db.insert(schema.memberRoles).values({
      spaceId: id,
      userId: uid,
      roleId,
    }).onConflictDoNothing().run();

    announceAccessChange(id, [uid]);

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/spaces/:id/members/:uid/roles/:roleId - Remove role from member
  app.delete<{ Params: { id: string; uid: string; roleId: string } }>('/api/spaces/:id/members/:uid/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid, roleId } = request.params;
    const db = getDb();

    const refusal = checkSingleRoleChange(id, request.userId, uid, roleId, 'remove');
    if (refusal) return sendError(reply, refusal.status, refusal.code, refusal.details);

    db.delete(schema.memberRoles).where(and(
      eq(schema.memberRoles.spaceId, id),
      eq(schema.memberRoles.userId, uid),
      eq(schema.memberRoles.roleId, roleId)
    )).run();

    announceAccessChange(id, [uid]);

    return reply.code(200).send({ success: true });
  });

  // PATCH /api/spaces/:id/transfer-ownership — Transfer space ownership
  app.patch<{ Params: { id: string }; Body: { newOwnerId: string } }>('/api/spaces/:id/transfer-ownership', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { newOwnerId } = request.body;
    const db = getDb();

    if (!newOwnerId || typeof newOwnerId !== 'string') {
      return sendError(reply, 400, 'new_owner_required');
    }

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!isSpaceOwner(id, request.userId)) {
      return sendError(reply, 403, 'space_owner_only');
    }

    if (newOwnerId === request.userId) {
      return sendError(reply, 400, 'already_owner');
    }

    // Verify new owner is a member
    if (!isMember(id, newOwnerId)) {
      return sendError(reply, 400, 'new_owner_not_member');
    }

    db.update(schema.spaces).set({ ownerId: newOwnerId }).where(eq(schema.spaces.id, id)).run();

    const updated = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!updated) {
      return sendError(reply, 500, 'ownership_transfer_failed');
    }

    const spaceData = rowToSpace(updated);

    // Broadcast space_updated so all clients see the new owner
    connectionManager.sendToSpace(id, {
      type: 'space_updated',
      space: spaceData,
    });

    return reply.code(200).send(spaceData);
  });

  // GET /api/spaces/invite/:code/preview — Public invite preview (no auth)
  app.get<{ Params: { code: string } }>('/api/spaces/invite/:code/preview', async (request, reply) => {
    const { code } = request.params;
    const snapshot = getLocalInviteSnapshot(code);
    if (!snapshot) {
      return sendError(reply, 404, 'invite_not_found');
    }
    return reply.code(200).send(snapshot);
  });

  // ─── Ban Management ───────────────────────────────────────────────────────

  // GET /api/spaces/:id/bans - List bans
  app.get<{ Params: { id: string } }>('/api/spaces/:id/bans', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.BAN_MEMBERS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'BAN_MEMBERS' });
    }

    const banRows = db.select().from(schema.bans)
      .where(eq(schema.bans.spaceId, id))
      .all();

    if (banRows.length === 0) return reply.code(200).send([]);

    const userIds = [...new Set(banRows.map(b => b.userId))];
    const bannedByIds = [...new Set(banRows.map(b => b.bannedBy))];
    const allUserIds = [...new Set([...userIds, ...bannedByIds].filter((id): id is string => id !== null))];
    const users = allUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, allUserIds)).all()
      : [];
    const userMap = new Map(users.map(u => [u.id, u]));

    const bans = banRows.map(b => {
      const user = userMap.get(b.userId);
      const moderator = b.bannedBy ? userMap.get(b.bannedBy) : undefined;
      return {
        spaceId: b.spaceId,
        userId: b.userId,
        reason: b.reason,
        bannedBy: b.bannedBy,
        createdAt: b.createdAt,
        user: user ? sanitizeUser(user) : null,
        moderator: moderator ? sanitizeUser(moderator) : null,
      };
    });

    return reply.code(200).send(bans);
  });

  // POST /api/spaces/:id/bans - Ban a member
  app.post<{ Params: { id: string }; Body: { userId: string; reason?: string } }>('/api/spaces/:id/bans', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { userId: targetId, reason } = request.body;
    const db = getDb();

    if (!targetId || typeof targetId !== 'string') {
      return sendError(reply, 400, 'user_id_required');
    }

    if (!hasPermission(request.userId, id, PermissionBits.BAN_MEMBERS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'BAN_MEMBERS' });
    }

    // Cannot ban the space owner
    if (isSpaceOwner(id, targetId)) {
      return sendError(reply, 400, 'cannot_target_owner');
    }

    // Cannot ban yourself
    if (targetId === request.userId) {
      return sendError(reply, 400, 'cannot_target_self');
    }

    // Banning needs a higher top role than the target's
    if (!canActOnMemberInSpace(id, request.userId, targetId)) {
      return sendError(reply, 403, 'role_hierarchy');
    }

    // Check if already banned
    if (isBanned(id, targetId)) {
      return sendError(reply, 409, 'already_banned');
    }

    const now = Date.now();

    // Fetch channel IDs before the transaction for read_states cleanup
    const banChannelIds = db.select({ id: schema.channels.id })
      .from(schema.channels).where(eq(schema.channels.spaceId, id)).all().map(c => c.id);

    db.transaction((tx) => {
      // Insert ban record
      tx.insert(schema.bans).values({
        spaceId: id,
        userId: targetId,
        reason: reason?.trim() || null,
        bannedBy: request.userId,
        createdAt: now,
      }).run();

      // Remove member from space
      tx.delete(schema.spaceMembers).where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, targetId),
      )).run();

      // Remove member's role assignments
      tx.delete(schema.memberRoles).where(and(
        eq(schema.memberRoles.spaceId, id),
        eq(schema.memberRoles.userId, targetId),
      )).run();

      // Clean up read_states for the banned user in this space's channels
      if (banChannelIds.length > 0) {
        tx.delete(schema.readStates).where(and(
          eq(schema.readStates.userId, targetId),
          inArray(schema.readStates.channelId, banChannelIds),
        )).run();
      }

      // Clean up any voice restrictions for the banned member
      tx.delete(schema.voiceRestrictions).where(and(
        eq(schema.voiceRestrictions.spaceId, id),
        eq(schema.voiceRestrictions.userId, targetId),
      )).run();
    });

    // Broadcast member_left event so other clients update their member list
    connectionManager.sendToSpace(id, {
      type: 'member_left',
      spaceId: id,
      userId: targetId,
    });

    // Notify the banned user
    connectionManager.sendToUser(targetId, {
      type: 'member_banned',
      spaceId: id,
      reason: reason?.trim() || null,
    });

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/spaces/:id/bans/:uid - Unban a user
  app.delete<{ Params: { id: string; uid: string } }>('/api/spaces/:id/bans/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.BAN_MEMBERS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'BAN_MEMBERS' });
    }

    const result = db.delete(schema.bans).where(and(
      eq(schema.bans.spaceId, id),
      eq(schema.bans.userId, uid),
    )).run();

    if (result.changes === 0) {
      return sendError(reply, 404, 'ban_not_found');
    }

    return reply.code(200).send({ success: true });
  });
}
