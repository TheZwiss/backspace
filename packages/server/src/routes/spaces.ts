import type { Channel, ChannelCategory, CreateSpaceRequest, MemberWithUser, SpaceWithChannelsAndMembers } from '@backspace/shared';
import { AVATAR_COLORS } from '@backspace/shared';
import { DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';
import crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import path from 'path';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { deleteAttachmentByFilename } from '../utils/fileCleanup.js';
import { sendError } from '../utils/httpErrors';
import { computePermissions, isMember, PermissionBits } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { resizeProfileImage } from '../utils/thumbnail.js';
import { connectionManager } from '../ws/handler.js';
import { spaceBanRoutes } from './spaceBans.js';
import { spaceInviteRoutes } from './spaceInvites.js';
import { listSpaceMemberRoutes, removeSpaceMemberRoutes, updateSpaceMemberRoutes } from './spaceMembers.js';
import { spaceRoleRoutes } from './spaceRoles.js';
import { rowToSpace } from './spaceSerialization.js';
import { deleteSpaceRoutes, transferSpaceRoutes, updateSpaceRoutes } from './spaceUpdates.js';

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


export function createSpaceRoutes(app: FastifyInstance): void {
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
    const inviteCode = crypto.randomBytes(4).toString('hex');

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
}

export function readSpaceRoutes(app: FastifyInstance): void {
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

        const assignedRoleIds = memberRoleRows
          .filter(mr => mr.userId === m.userId)
          .map(mr => mr.roleId);
        
        const memberRoles = roles
          .filter(r => assignedRoleIds.includes(r.id))
          .map(r => ({
            id: r.id,
            spaceId: r.spaceId,
            name: r.name,
            color: r.color ?? '#b9bbbe',
            position: r.position ?? 0,
            createdAt: r.createdAt,
          }));

        return {
          spaceId: m.spaceId,
          userId: m.userId,
          nickname: m.nickname,
          joinedAt: m.joinedAt,
          user: sanitizeUser(user),
          roles: memberRoles,
        };
      })
      .filter((m): m is MemberWithUser => m !== null);

    // Fetch categories for this space
    const categoryRows = db.select()
      .from(schema.channelCategories)
      .where(eq(schema.channelCategories.spaceId, id))
      .all();

    // Batch-fetch category overrides for @everyone to determine isPrivate
    const catEveryoneOverrides = db.select().from(schema.categoryOverrides)
      .where(and(
        eq(schema.categoryOverrides.targetType, 'role'),
        eq(schema.categoryOverrides.targetId, id),
      ))
      .all();
    const privateCategoryIds = new Set<string>();
    for (const o of catEveryoneOverrides) {
      const denyBits = BigInt(o.deny || '0');
      if ((denyBits & PermissionBits.VIEW_CHANNEL) !== 0n) {
        privateCategoryIds.add(o.categoryId);
      }
    }

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

    // Batch-fetch all channel overrides for @everyone (role = spaceId) to determine isPrivate
    const everyoneOverrides = db.select().from(schema.channelOverrides)
      .where(and(
        eq(schema.channelOverrides.targetType, 'role'),
        eq(schema.channelOverrides.targetId, id),
      ))
      .all();
    const privateChannelIds = new Set<string>();
    for (const o of everyoneOverrides) {
      const denyBits = BigInt(o.deny || '0');
      if ((denyBits & PermissionBits.VIEW_CHANNEL) !== 0n) {
        privateChannelIds.add(o.channelId);
      }
    }

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

    const canManageRoles = (spacePerms & PermissionBits.MANAGE_ROLES) !== 0n;

    const result: SpaceWithChannelsAndMembers = {
      ...rowToSpace(server),
      channels: visibleChannels,
      categories,
      members,
      roles: roles.map(r => ({
        id: r.id,
        spaceId: r.spaceId,
        name: r.name,
        color: r.color ?? '#b9bbbe',
        position: r.position ?? 0,
        permissions: canManageRoles ? (r.permissions ?? '0') : undefined,
        createdAt: r.createdAt,
      })),
      myPermissions: permissionsToString(spacePerms),
    };

    return reply.code(200).send(result);
  });
}

export async function spaceRoutes(app: FastifyInstance): Promise<void> {
  createSpaceRoutes(app);
  readSpaceRoutes(app);
  updateSpaceRoutes(app);
  deleteSpaceRoutes(app);
  transferSpaceRoutes(app);
  spaceInviteRoutes(app);
  listSpaceMemberRoutes(app);
  updateSpaceMemberRoutes(app);
  removeSpaceMemberRoutes(app);
  spaceRoleRoutes(app);
  spaceBanRoutes(app);
}
