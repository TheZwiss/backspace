import type { UpdateSpaceRequest } from '@backspace/shared';
import { AVATAR_COLORS } from '@backspace/shared';
import { MAX_OWNER_TITLE_LENGTH } from '@backspace/shared/src/constants.js';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import path from 'path';
import { config } from '../config.js';
import { getDb, getRawDb, schema } from '../db/index.js';
import { markDirectoryDirty } from '../directory/state.js';
import { authenticate } from '../utils/auth.js';
import { deleteAttachmentByFilename, deleteAttachmentFiles, deleteUploadFile } from '../utils/fileCleanup.js';
import { sendError } from '../utils/httpErrors';
import { hasPermission, isMember, isSpaceOwner, PermissionBits } from '../utils/permissions.js';
import { resizeProfileImage } from '../utils/thumbnail.js';
import { connectionManager } from '../ws/handler.js';
import { rowToSpace } from './spaceSerialization.js';

/**
 * The space columns the directory document serves (spec section 4). A change
 * to any of them on a listed space owes a ping.
 */
const DIRECTORY_SPACE_FIELDS = ['name', 'description', 'icon', 'banner', 'avatarColor', 'visibility'] as const;


export function updateSpaceRoutes(app: FastifyInstance): void {
  // PATCH /api/spaces/:id - Update server (owner only)
  app.patch<{ Params: { id: string }; Body: UpdateSpaceRequest }>('/api/spaces/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, icon, banner, avatarColor, visibility, description, directoryListed, ownerTitle } = request.body;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    // A display title is personal to the owner, not a MANAGE_SPACE capability.
    if (ownerTitle !== undefined && server.ownerId !== request.userId) {
      return sendError(reply, 403, 'space_owner_only');
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_SPACE)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_SPACE' });
    }

    const updates: Partial<typeof schema.spaces.$inferInsert> = {};

    if (ownerTitle !== undefined) {
      if (ownerTitle !== null && (typeof ownerTitle !== 'string'
        || !ownerTitle.trim() || ownerTitle.trim().length > MAX_OWNER_TITLE_LENGTH
        || /[\r\n]/.test(ownerTitle))) {
        return sendError(reply, 400, 'space_owner_title_invalid', { max: MAX_OWNER_TITLE_LENGTH });
      }
      updates.ownerTitle = ownerTitle === null ? null : ownerTitle.trim();
    }

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
}

export function deleteSpaceRoutes(app: FastifyInstance): void {
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
        tx.delete(schema.notificationSettings).where(inArray(schema.notificationSettings.targetId, channelIds)).run();
      }
      // notification_settings has no FK on target_id (it serves two target kinds)
      tx.delete(schema.notificationSettings).where(eq(schema.notificationSettings.targetId, id)).run();
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
}

export function transferSpaceRoutes(app: FastifyInstance): void {
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

    // A new owner does not inherit the former owner's self-chosen title.
    db.update(schema.spaces).set({ ownerId: newOwnerId, ownerTitle: null }).where(eq(schema.spaces.id, id)).run();

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
}
