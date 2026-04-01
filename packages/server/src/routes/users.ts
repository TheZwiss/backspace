import type { FastifyInstance } from 'fastify';
import { eq, or, and, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, verifyPassword, hashPassword, signJwt } from '../utils/auth.js';
import { connectionManager } from '../ws/handler.js';
import type { UpdateUserRequest, VerifyPasswordRequest, VerifyPasswordResponse, ChangePasswordRequest, ChangePasswordResponse, DeleteAccountRequest, ReplicatedInstance, SpaceLayoutItem, SpaceFolder, Activity } from '@backspace/shared';
import { AVATAR_COLORS } from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';
import { deleteUploadFile, deleteAttachmentByFilename } from '../utils/fileCleanup.js';
import { tombstoneUser } from '../utils/userDeletion.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { resizeProfileImage } from '../utils/thumbnail.js';
import { config } from '../config.js';
import path from 'path';

/** Validates that a URL is a safe asset URL (relative upload path, bare filename, or http/https) */
function isValidAssetUrl(url: string | null | undefined): boolean {
  if (!url || url.trim().length === 0) return true; // empty/null = clearing
  const trimmed = url.trim();
  if (trimmed.startsWith('/api/uploads/')) return true;
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return true;
  // Accept bare filenames (the existing convention) — no slashes, no traversal
  if (!trimmed.includes('/') && !trimmed.includes('\\') && !trimmed.includes('..')) return true;
  return false;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users/@me', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();

    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user || user.isDeleted) {
      return reply.code(401).send({ error: 'This account has been deleted', statusCode: 401 });
    }

    return reply.code(200).send(sanitizeUser(user, true));
  });

  // POST /api/users/@me/verify-password — verify password matches current account
  app.post<{ Body: VerifyPasswordRequest }>('/api/users/@me/verify-password', { preHandler: authenticate }, async (request, reply) => {
    const { password } = request.body;

    if (!password || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Password is required', statusCode: 400 });
    }

    const db = getDb();
    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    const response: VerifyPasswordResponse = { valid };
    return reply.code(200).send(response);
  });

  // POST /api/users/@me/change-password — change account password
  app.post<{ Body: ChangePasswordRequest }>('/api/users/@me/change-password', {
    preHandler: authenticate,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body;

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return reply.code(400).send({ error: 'New password must be at least 8 characters', statusCode: 400 });
    }

    const db = getDb();
    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    // Federated users (replicas on this instance) don't need currentPassword —
    // their home instance already verified the password change, and JWT auth
    // proves identity. The homeInstance field comes from the DB, not the request.
    if (!user.homeInstance) {
      // Local users must provide current password
      if (!currentPassword || typeof currentPassword !== 'string') {
        return reply.code(400).send({ error: 'Current password is required', statusCode: 400 });
      }
      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        return reply.code(403).send({ error: 'Incorrect password', statusCode: 403 });
      }
    }

    const newHash = await hashPassword(newPassword);
    db.update(schema.users).set({ passwordHash: newHash, passwordChangedAt: Date.now() }).where(eq(schema.users.id, request.userId)).run();

    // Issue fresh JWT
    const token = signJwt({ userId: user.id, username: user.username });
    const response: ChangePasswordResponse = { token };
    return reply.code(200).send(response);
  });

  // DELETE /api/users/@me — delete (tombstone) account
  app.delete<{ Body: DeleteAccountRequest }>('/api/users/@me', {
    preHandler: authenticate,
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { password, username } = request.body;

    if (!username || typeof username !== 'string') {
      return reply.code(400).send({ error: 'Username confirmation is required', statusCode: 400 });
    }

    const db = getDb();
    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    // Verify username matches (confirmation safeguard)
    if (user.username !== username) {
      return reply.code(400).send({ error: 'Username does not match', statusCode: 400 });
    }

    // Native users must verify password; federated users rely on JWT auth
    if (!user.homeInstance) {
      if (!password || typeof password !== 'string') {
        return reply.code(400).send({ error: 'Password is required', statusCode: 400 });
      }
      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return reply.code(403).send({ error: 'Incorrect password', statusCode: 403 });
      }
    }

    // Check if user owns any spaces
    const ownedSpaces = db.select({ id: schema.spaces.id, name: schema.spaces.name })
      .from(schema.spaces)
      .where(eq(schema.spaces.ownerId, request.userId))
      .all();
    if (ownedSpaces.length > 0) {
      return reply.code(400).send({
        error: 'You must transfer ownership or delete all spaces you own before deleting your account',
        statusCode: 400,
        ownedSpaces,
      });
    }

    // Tombstone the account (transaction handles all DB cleanup)
    const filesToDelete = tombstoneUser(request.userId);

    // Clean up files from disk after transaction commits
    for (const filename of filesToDelete) {
      deleteUploadFile(filename);
    }

    // Force-close all WebSocket connections
    connectionManager.forceDisconnectUser(request.userId);

    return reply.code(200).send({ success: true });
  });

  app.patch<{ Body: UpdateUserRequest }>('/api/users/@me', { preHandler: authenticate }, async (request, reply) => {
    const { displayName, avatar, banner, accentColor, avatarColor, bio, customStatus, status, replicatedInstances, homeUserId, profileUpdatedAt, discoverable, showActivity } = request.body;
    const db = getDb();

    const updateData: Record<string, string | null | undefined> = {};

    if (displayName !== undefined) {
      if (displayName !== null && typeof displayName === 'string') {
        const trimmed = displayName.trim();
        if (trimmed.length > 32) {
          return reply.code(400).send({ error: 'Display name must be 32 characters or less', statusCode: 400 });
        }
        updateData.displayName = trimmed || null;
      } else {
        updateData.displayName = null;
      }
    }

    // Track old files for cleanup after update
    let oldAvatar: string | null = null;
    let oldBanner: string | null = null;
    if (avatar !== undefined || banner !== undefined) {
      const current = db.select({ avatar: schema.users.avatar, banner: schema.users.banner })
        .from(schema.users).where(eq(schema.users.id, request.userId)).get();
      oldAvatar = current?.avatar ?? null;
      oldBanner = current?.banner ?? null;
    }

    if (avatar !== undefined) {
      if (!isValidAssetUrl(avatar)) {
        return reply.code(400).send({ error: 'Avatar URL must be a relative upload path or http/https URL', statusCode: 400 });
      }
      updateData.avatar = avatar;
      // Normalize to bare filename — profileSync historically stored /api/uploads/ prefix
      if (typeof updateData.avatar === 'string' && updateData.avatar.startsWith('/api/uploads/')) {
        updateData.avatar = updateData.avatar.slice('/api/uploads/'.length);
      }
    }

    if (banner !== undefined) {
      if (!isValidAssetUrl(banner)) {
        return reply.code(400).send({ error: 'Banner URL must be a relative upload path or http/https URL', statusCode: 400 });
      }
      if (banner && typeof banner === 'string' && banner.trim().length > 0) {
        updateData.banner = banner.trim();
        // Normalize to bare filename — profileSync historically stored /api/uploads/ prefix
        if (updateData.banner.startsWith('/api/uploads/')) {
          updateData.banner = updateData.banner.slice('/api/uploads/'.length);
        }
      } else {
        updateData.banner = null;
      }
    }

    if (accentColor !== undefined) {
      if (accentColor && typeof accentColor === 'string' && accentColor.trim().length > 0) {
        const hex = accentColor.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
          return reply.code(400).send({ error: 'Accent color must be a valid hex color (e.g. #ff0000)', statusCode: 400 });
        }
        updateData.accentColor = hex;
      } else {
        updateData.accentColor = null;
      }
    }

    if (avatarColor !== undefined) {
      if (avatarColor && typeof avatarColor === 'string' && avatarColor.trim().length > 0) {
        const trimmed = avatarColor.trim();
        if (!(AVATAR_COLORS as readonly string[]).includes(trimmed)) {
          return reply.code(400).send({ error: `Invalid avatar color. Must be one of: ${AVATAR_COLORS.join(', ')}`, statusCode: 400 });
        }
        updateData.avatarColor = trimmed;
      } else {
        updateData.avatarColor = null;
      }
    }

    if (bio !== undefined) {
      if (bio && typeof bio === 'string') {
        const trimmed = bio.trim();
        if (trimmed.length > 190) {
          return reply.code(400).send({ error: 'Bio must be 190 characters or less', statusCode: 400 });
        }
        updateData.bio = trimmed || null;
      } else {
        updateData.bio = null;
      }
    }

    if (customStatus !== undefined) {
      if (customStatus !== null && typeof customStatus === 'string') {
        const trimmed = customStatus.trim();
        if (trimmed.length > 128) {
          return reply.code(400).send({ error: 'Custom status must be 128 characters or less', statusCode: 400 });
        }
        updateData.customStatus = trimmed || null;
      } else {
        updateData.customStatus = null;
      }
    }

    if (status !== undefined) {
      if (!['online', 'idle', 'dnd', 'offline'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status', statusCode: 400 });
      }
      updateData.status = status;
    }

    if (replicatedInstances !== undefined) {
      if (!Array.isArray(replicatedInstances)) {
        return reply.code(400).send({ error: 'replicatedInstances must be an array', statusCode: 400 });
      }
      if (replicatedInstances.length > 20) {
        return reply.code(400).send({ error: 'Maximum 20 replicated instances', statusCode: 400 });
      }
      const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
      for (const inst of replicatedInstances) {
        if (!inst || typeof inst.username !== 'string' || inst.username.trim().length === 0) {
          return reply.code(400).send({ error: 'Each replicated instance must have a non-empty username string', statusCode: 400 });
        }
        if (inst.username.length > 255) {
          return reply.code(400).send({ error: 'Instance username must be 255 characters or less', statusCode: 400 });
        }
        if (typeof inst.origin !== 'string' && typeof inst.domain !== 'string') {
          return reply.code(400).send({ error: 'Each replicated instance must have origin or domain string', statusCode: 400 });
        }
        if (typeof inst.origin === 'string') {
          if (inst.origin.length > 512) {
            return reply.code(400).send({ error: 'Instance origin must be 512 characters or less', statusCode: 400 });
          }
          if (!inst.origin.startsWith('https://') && !inst.origin.startsWith('http://')) {
            return reply.code(400).send({ error: 'Instance origin must start with https:// or http://', statusCode: 400 });
          }
        }
        if (typeof inst.domain === 'string') {
          if (inst.domain.length > 253) {
            return reply.code(400).send({ error: 'Instance domain must be 253 characters or less', statusCode: 400 });
          }
          if (!domainRegex.test(inst.domain)) {
            return reply.code(400).send({ error: 'Instance domain contains invalid characters', statusCode: 400 });
          }
        }
      }
      updateData.replicatedInstances = JSON.stringify(replicatedInstances);
    }

    if (homeUserId !== undefined) {
      // Only allow setting homeUserId for replicated users (has homeInstance)
      const currentUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
      if (currentUser?.homeInstance && typeof homeUserId === 'string' && homeUserId.length > 0) {
        updateData.homeUserId = homeUserId;
      }
    }

    if (discoverable !== undefined) {
      if (typeof discoverable !== 'boolean') {
        return reply.code(400).send({ error: 'discoverable must be a boolean', statusCode: 400 });
      }
      (updateData as Record<string, unknown>).discoverable = discoverable ? 1 : 0;
    }

    if (showActivity !== undefined) {
      if (typeof showActivity !== 'boolean') {
        return reply.code(400).send({ error: 'showActivity must be a boolean', statusCode: 400 });
      }
      (updateData as Record<string, unknown>).showActivity = showActivity ? 1 : 0;
    }

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({ error: 'No fields to update', statusCode: 400 });
    }

    // LWW guard: if the caller provided a profileUpdatedAt and profile fields changed,
    // reject stale writes by comparing timestamps
    const profileFields = ['displayName', 'avatar', 'banner', 'accentColor', 'avatarColor', 'bio', 'customStatus'];
    const hasProfileChange = profileFields.some(f => f in updateData);

    if (hasProfileChange) {
      if (profileUpdatedAt !== undefined && typeof profileUpdatedAt === 'number') {
        const currentUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
        if (currentUser) {
          const storedTs = currentUser.profileUpdatedAt ?? currentUser.createdAt;
          if (profileUpdatedAt < storedTs) {
            // Incoming data is older — return current state without updating
            return reply.code(200).send(sanitizeUser(currentUser, true));
          }
        }
        (updateData as Record<string, unknown>).profileUpdatedAt = profileUpdatedAt;
      } else {
        // No explicit timestamp — stamp with server time (local edits)
        (updateData as Record<string, unknown>).profileUpdatedAt = Date.now();
      }
    }

    db.update(schema.users).set(updateData).where(eq(schema.users.id, request.userId)).run();

    // Update activity visibility cache and broadcast clear when toggled off
    if (showActivity !== undefined) {
      connectionManager.setUserShowActivity(request.userId, showActivity);
      if (!showActivity) {
        connectionManager.clearUserActivities(request.userId);
        const userSpaces = connectionManager.getUserSpaces(request.userId);
        const clearPayload = {
          type: 'presence_update' as const,
          userId: request.userId,
          status: connectionManager.getUserStatus(request.userId),
          activities: [] as Activity[],
        };
        for (const spaceId of userSpaces) {
          connectionManager.sendToSpace(spaceId, clearPayload, request.userId);
        }
        connectionManager.sendToUser(request.userId, clearPayload);
      }
    }

    // Clean up old avatar/banner files that were replaced
    if (avatar !== undefined && oldAvatar && oldAvatar !== (avatar || null) && !oldAvatar.startsWith('http')) {
      deleteUploadFile(oldAvatar);
      deleteAttachmentByFilename(oldAvatar);
    }
    if (banner !== undefined && oldBanner && oldBanner !== (updateData.banner ?? null) && !oldBanner.startsWith('http')) {
      deleteUploadFile(oldBanner);
      deleteAttachmentByFilename(oldBanner);
    }
    // Clean up attachment records for newly-set profile images — the reference
    // now lives in the users table, so the attachment record is unnecessary
    if (avatar && typeof avatar === 'string' && avatar.includes('/api/uploads/')) {
      deleteAttachmentByFilename(avatar);
    }
    if (updateData.banner && typeof updateData.banner === 'string' && updateData.banner.includes('/api/uploads/')) {
      deleteAttachmentByFilename(updateData.banner);
    }

    // Resize profile images to optimal dimensions (safety net for federation, API clients, etc.)
    if (avatar && typeof avatar === 'string' && !avatar.startsWith('http')) {
      const filePath = path.join(config.uploadDir, path.basename(avatar));
      await resizeProfileImage(filePath, 'avatar');
    }
    if (updateData.banner && typeof updateData.banner === 'string' && !updateData.banner.startsWith('http')) {
      const filePath = path.join(config.uploadDir, path.basename(updateData.banner));
      await resizeProfileImage(filePath, 'banner');
    }

    const updatedUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!updatedUser) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    const sanitized = sanitizeUser(updatedUser, true);

    // Broadcast presence update if status changed
    if (status !== undefined) {
      const userSpaces = connectionManager.getUserSpaces(sanitized.id);
      for (const spaceId of userSpaces) {
        connectionManager.sendToSpace(spaceId, {
          type: 'presence_update',
          userId: sanitized.id,
          status: status,
        }, sanitized.id);
      }
      connectionManager.sendToUser(sanitized.id, {
        type: 'presence_update',
        userId: sanitized.id,
        status: status,
      });
    }

    // Broadcast user_updated for profile field changes (reuse hasProfileChange from LWW guard above)
    if (hasProfileChange) {
      const userUpdatedEvent = { type: 'user_updated' as const, user: sanitized };
      const targetUserIds = new Set<string>();

      // 1. Collect online users who share a space
      const userSpaces = connectionManager.getUserSpaces(sanitized.id);
      for (const [uid, spaceIds] of connectionManager.getUserSpaceEntries()) {
        for (const spaceId of userSpaces) {
          if (spaceIds.has(spaceId)) { targetUserIds.add(uid); break; }
        }
      }

      // 2. Collect DM channel co-members
      const dmMemberships = db.select().from(schema.dmMembers)
        .where(eq(schema.dmMembers.userId, sanitized.id)).all();
      for (const dm of dmMemberships) {
        const coMembers = db.select().from(schema.dmMembers)
          .where(eq(schema.dmMembers.dmChannelId, dm.dmChannelId)).all();
        for (const m of coMembers) targetUserIds.add(m.userId);
      }

      // 3. Collect friends
      const friendRows = db.select().from(schema.friends)
        .where(or(
          eq(schema.friends.userId, sanitized.id),
          eq(schema.friends.friendId, sanitized.id),
        )).all();
      for (const fr of friendRows) {
        targetUserIds.add(fr.userId === sanitized.id ? fr.friendId : fr.userId);
      }

      // 4. Include self (for other tabs/connections)
      targetUserIds.add(sanitized.id);

      // Send deduplicated — each user gets the event exactly once
      for (const uid of targetUserIds) {
        connectionManager.sendToUser(uid, userUpdatedEvent);
      }
    }

    return reply.code(200).send(sanitized);
  });

  // GET /api/users/@me/federation-registry — retrieve persistent federation registry
  app.get('/api/users/@me/federation-registry', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.userId;
    const db = getDb();

    const entries = db.select().from(schema.userFederationRegistry)
      .where(eq(schema.userFederationRegistry.userId, userId))
      .all();

    const user = db.select({ federationRegistryUpdatedAt: schema.users.federationRegistryUpdatedAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();

    return reply.code(200).send({
      registry: entries.map((e) => ({
        origin: e.origin,
        label: e.label,
        username: e.username,
        remoteUserId: e.remoteUserId,
        status: e.status,
        addedAt: e.addedAt,
        lastConnectedAt: e.lastConnectedAt,
        disconnectedAt: e.disconnectedAt,
        errorMessage: e.errorMessage,
      })),
      updatedAt: user?.federationRegistryUpdatedAt ?? 0,
    });
  });

  // PUT /api/users/@me/federation-registry — replace federation registry (LWW)
  app.put<{ Body: { registry: Array<{ origin: string; label?: string; username?: string; remoteUserId?: string; status: string; addedAt: number; lastConnectedAt?: number | null; disconnectedAt?: number | null; errorMessage?: string | null }>; updatedAt: number } }>(
    '/api/users/@me/federation-registry', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.userId;
    const { registry, updatedAt } = request.body;

    if (!Array.isArray(registry)) {
      return reply.code(400).send({ error: 'registry must be an array', statusCode: 400 });
    }
    if (typeof updatedAt !== 'number' || updatedAt <= 0) {
      return reply.code(400).send({ error: 'updatedAt must be a positive number', statusCode: 400 });
    }

    // Size cap — prevent unbounded registry writes
    if (registry.length > 100) {
      return reply.code(400).send({ error: 'Registry cannot exceed 100 entries', statusCode: 400 });
    }

    // Duplicate origin check
    const origins = registry.map(e => e.origin);
    if (new Set(origins).size !== origins.length) {
      return reply.code(400).send({ error: 'Duplicate origins are not allowed', statusCode: 400 });
    }

    const validStatuses = ['connected', 'disconnected', 'unreachable', 'auth_expired'];
    for (const entry of registry) {
      if (!entry || typeof entry.origin !== 'string' || !entry.origin) {
        return reply.code(400).send({ error: 'Each entry must have a string origin', statusCode: 400 });
      }
      if (!validStatuses.includes(entry.status)) {
        return reply.code(400).send({ error: `Invalid status "${entry.status}" — must be one of: ${validStatuses.join(', ')}`, statusCode: 400 });
      }
      if (typeof entry.addedAt !== 'number') {
        return reply.code(400).send({ error: 'Each entry must have a numeric addedAt', statusCode: 400 });
      }
    }

    const db = getDb();

    // LWW guard: reject if incoming timestamp is not newer than stored
    const user = db.select({ federationRegistryUpdatedAt: schema.users.federationRegistryUpdatedAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();

    const storedUpdatedAt = user?.federationRegistryUpdatedAt ?? 0;
    if (updatedAt <= storedUpdatedAt) {
      return reply.code(409).send({ error: 'Conflict: incoming registry is not newer than stored version', statusCode: 409 });
    }

    // Atomic replace: delete existing, insert all incoming, update timestamp
    db.transaction((tx) => {
      tx.delete(schema.userFederationRegistry)
        .where(eq(schema.userFederationRegistry.userId, userId))
        .run();

      if (registry.length > 0) {
        tx.insert(schema.userFederationRegistry).values(
          registry.map((e) => ({
            userId,
            origin: e.origin,
            label: e.label ?? '',
            username: e.username ?? '',
            remoteUserId: e.remoteUserId ?? '',
            status: e.status,
            addedAt: e.addedAt,
            lastConnectedAt: e.lastConnectedAt ?? null,
            disconnectedAt: e.disconnectedAt ?? null,
            errorMessage: e.errorMessage ?? null,
          }))
        ).run();
      }

      tx.update(schema.users)
        .set({ federationRegistryUpdatedAt: updatedAt })
        .where(eq(schema.users.id, userId))
        .run();
    });

    return reply.code(200).send({ ok: true, updatedAt });
  });

  // PUT /api/users/@me/space-layout — save sidebar layout (reorder, folders)
  app.put<{ Body: { items: SpaceLayoutItem[]; folders: Record<string, { name: string | null; color: string | null; spaceIds: string[] }>; updatedAt?: number } }>(
    '/api/users/@me/space-layout', { preHandler: authenticate }, async (request, reply) => {
    const { items, folders, updatedAt: incomingTs } = request.body;
    const userId = request.userId;

    if (!Array.isArray(items)) {
      return reply.code(400).send({ error: 'items must be an array', statusCode: 400 });
    }
    if (!folders || typeof folders !== 'object') {
      return reply.code(400).send({ error: 'folders must be an object', statusCode: 400 });
    }

    // Validate items
    for (const item of items) {
      if (!item || (item.t !== 's' && item.t !== 'f') || typeof item.id !== 'string') {
        return reply.code(400).send({ error: 'Each item must have t ("s" or "f") and id string', statusCode: 400 });
      }
    }

    // Validate folders
    for (const [key, folder] of Object.entries(folders)) {
      if (!Array.isArray(folder.spaceIds)) {
        return reply.code(400).send({ error: `Folder "${key}" must have spaceIds array`, statusCode: 400 });
      }
    }

    const db = getDb();

    // LWW guard: reject stale layout writes
    if (incomingTs !== undefined && typeof incomingTs === 'number') {
      const existingLayout = db.select().from(schema.userSpaceLayout)
        .where(eq(schema.userSpaceLayout.userId, userId)).get();
      if (existingLayout && incomingTs < existingLayout.updatedAt) {
        // Incoming layout is older — return current state without updating
        const currentItems: SpaceLayoutItem[] = JSON.parse(existingLayout.layout);
        const currentFolderRows = db.select().from(schema.spaceFolders)
          .where(eq(schema.spaceFolders.userId, userId))
          .orderBy(schema.spaceFolders.position)
          .all();
        const currentFolders: SpaceFolder[] = currentFolderRows.map(folder => {
          const memberRows = db.select()
            .from(schema.spaceFolderMembers)
            .where(eq(schema.spaceFolderMembers.folderId, folder.id))
            .orderBy(schema.spaceFolderMembers.position)
            .all();
          return {
            id: folder.id,
            userId: folder.userId,
            name: folder.name,
            color: folder.color,
            position: folder.position ?? 0,
            spaceIds: memberRows.map(m => m.spaceId),
          };
        });
        return reply.code(200).send({ items: currentItems, folders: currentFolders, updatedAt: existingLayout.updatedAt });
      }
    }

    // Resolve the effective timestamp for this write
    const effectiveTs = (incomingTs !== undefined && typeof incomingTs === 'number') ? incomingTs : Date.now();

    // Map new:* folder keys to server-generated IDs
    const newIdMap = new Map<string, string>();
    for (const key of Object.keys(folders)) {
      if (key.startsWith('new:')) {
        newIdMap.set(key, generateSnowflake());
      }
    }

    db.transaction((tx) => {
      // Get existing folder IDs for this user
      const existingFolders = tx.select({ id: schema.spaceFolders.id })
        .from(schema.spaceFolders)
        .where(eq(schema.spaceFolders.userId, userId))
        .all();
      const existingFolderIds = new Set(existingFolders.map(f => f.id));

      // Determine which folders to keep (ones in the request, with resolved IDs)
      const keepFolderIds = new Set<string>();
      for (const [key, folder] of Object.entries(folders)) {
        const resolvedId = newIdMap.get(key) ?? key;
        keepFolderIds.add(resolvedId);

        if (key.startsWith('new:')) {
          // Create new folder
          tx.insert(schema.spaceFolders).values({
            id: resolvedId,
            userId,
            name: folder.name,
            color: folder.color,
            position: 0,
            createdAt: Date.now(),
          }).run();
        } else if (existingFolderIds.has(key)) {
          // Update existing folder
          tx.update(schema.spaceFolders)
            .set({ name: folder.name, color: folder.color })
            .where(and(eq(schema.spaceFolders.id, key), eq(schema.spaceFolders.userId, userId)))
            .run();
        } else {
          // Folder from a remote instance — create it locally with the original ID
          tx.insert(schema.spaceFolders).values({
            id: key,
            userId,
            name: folder.name,
            color: folder.color,
            position: 0,
            createdAt: Date.now(),
          }).run();
        }

        // Clear and re-insert folder members with position
        tx.delete(schema.spaceFolderMembers)
          .where(eq(schema.spaceFolderMembers.folderId, resolvedId))
          .run();

        for (let i = 0; i < folder.spaceIds.length; i++) {
          const spaceId = folder.spaceIds[i];
          if (!spaceId) continue;
          tx.insert(schema.spaceFolderMembers).values({
            folderId: resolvedId,
            spaceId,
            position: i,
          }).run();
        }
      }

      // Delete folders that are no longer in the request
      for (const existingId of existingFolderIds) {
        if (!keepFolderIds.has(existingId)) {
          tx.delete(schema.spaceFolderMembers)
            .where(eq(schema.spaceFolderMembers.folderId, existingId))
            .run();
          tx.delete(schema.spaceFolders)
            .where(and(eq(schema.spaceFolders.id, existingId), eq(schema.spaceFolders.userId, userId)))
            .run();
        }
      }

      // Replace new:* keys in items array with server-generated IDs
      const finalItems: SpaceLayoutItem[] = items.map(item => {
        if (item.t === 'f' && newIdMap.has(item.id)) {
          return { t: 'f' as const, id: newIdMap.get(item.id)! };
        }
        return item;
      });

      // Upsert user_space_layout
      const existing = tx.select().from(schema.userSpaceLayout)
        .where(eq(schema.userSpaceLayout.userId, userId)).get();
      if (existing) {
        tx.update(schema.userSpaceLayout)
          .set({ layout: JSON.stringify(finalItems), updatedAt: effectiveTs })
          .where(eq(schema.userSpaceLayout.userId, userId))
          .run();
      } else {
        tx.insert(schema.userSpaceLayout).values({
          userId,
          layout: JSON.stringify(finalItems),
          updatedAt: effectiveTs,
        }).run();
      }
    });

    // Build response: fetch final state
    const finalLayout = db.select().from(schema.userSpaceLayout)
      .where(eq(schema.userSpaceLayout.userId, userId)).get();
    const finalItems: SpaceLayoutItem[] = finalLayout ? JSON.parse(finalLayout.layout) : [];

    const finalFolderRows = db.select().from(schema.spaceFolders)
      .where(eq(schema.spaceFolders.userId, userId))
      .orderBy(schema.spaceFolders.position)
      .all();

    const responseFolders: SpaceFolder[] = [];
    for (const folder of finalFolderRows) {
      const memberRows = db.select()
        .from(schema.spaceFolderMembers)
        .where(eq(schema.spaceFolderMembers.folderId, folder.id))
        .orderBy(schema.spaceFolderMembers.position)
        .all();
      responseFolders.push({
        id: folder.id,
        userId: folder.userId,
        name: folder.name,
        color: folder.color,
        position: folder.position ?? 0,
        spaceIds: memberRows.map(m => m.spaceId),
      });
    }

    const layoutUpdatedAt = finalLayout?.updatedAt ?? effectiveTs;

    // Broadcast to user's other connections (multi-tab sync)
    connectionManager.sendToUser(userId, {
      type: 'space_layout_updated',
      layout: finalItems,
      folders: responseFolders,
      updatedAt: layoutUpdatedAt,
    });

    return reply.code(200).send({ items: finalItems, folders: responseFolders, updatedAt: layoutUpdatedAt });
  });

  app.get<{ Params: { id: string } }>('/api/users/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!user) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    return reply.code(200).send(sanitizeUser(user));
  });

  app.get<{ Params: { id: string }; Querystring: { homeUserId?: string } }>(
    '/api/users/:id/mutuals', { preHandler: authenticate }, async (request, reply) => {
    const { id: targetId } = request.params;
    const homeUserId = request.query.homeUserId;
    const myId = request.userId;
    const db = getDb();

    // Resolve target: try path ID first, then homeUserId fallback (federation)
    let resolvedTargetId = targetId;
    const directUser = db.select().from(schema.users).where(eq(schema.users.id, targetId)).get();
    if (!directUser && homeUserId) {
      const fallbackUser = db.select().from(schema.users)
        .where(or(eq(schema.users.homeUserId, homeUserId), eq(schema.users.id, homeUserId))).get();
      if (fallbackUser) resolvedTargetId = fallbackUser.id;
    }

    // Mutual friends: users who are friends with both me and the target
    const myFriendRows = db.select().from(schema.friends).where(
      or(eq(schema.friends.userId, myId), eq(schema.friends.friendId, myId))
    ).all();
    const targetFriendRows = db.select().from(schema.friends).where(
      or(eq(schema.friends.userId, resolvedTargetId), eq(schema.friends.friendId, resolvedTargetId))
    ).all();
    const myFriendIds = new Set(myFriendRows.map(f => f.userId === myId ? f.friendId : f.userId));
    const targetFriendIds = new Set(targetFriendRows.map(f => f.userId === resolvedTargetId ? f.friendId : f.userId));
    const mutualFriendIds = [...myFriendIds].filter((id) => targetFriendIds.has(id));

    const mutualFriends = mutualFriendIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, mutualFriendIds)).all().map(u => sanitizeUser(u))
      : [];

    // Mutual spaces: spaces both me and the target are members of
    const myMemberships = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.userId, myId)).all();
    const targetMemberships = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.userId, resolvedTargetId)).all();
    const mySpaceIds = new Set(myMemberships.map((m) => m.spaceId));
    const targetSpaceIds = new Set(targetMemberships.map((m) => m.spaceId));
    const mutualSpaceIds = [...mySpaceIds].filter((id) => targetSpaceIds.has(id));

    const mutualSpaces = mutualSpaceIds.length > 0
      ? db.select({ id: schema.spaces.id, name: schema.spaces.name, icon: schema.spaces.icon, avatarColor: schema.spaces.avatarColor })
          .from(schema.spaces)
          .where(inArray(schema.spaces.id, mutualSpaceIds))
          .all()
      : [];

    return reply.code(200).send({ mutualFriends, mutualSpaces });
  });
}
