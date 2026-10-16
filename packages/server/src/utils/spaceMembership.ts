import { and, eq, inArray } from 'drizzle-orm';
import type { MemberWithUser } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { connectionManager } from '../ws/handler.js';
import { sanitizeUser } from './sanitize.js';
import { createManagedBotRole, deleteManagedBotRole } from './botRoles.js';

/**
 * A bot's managed role in `spaceId` came or went: every member's client
 * reloads the space's roles and access (`space_access_changed`), and the
 * affected members get their voice view again. SPEAK needs no re-check: the
 * role is created as the bot joins and deleted as it leaves, never while it
 * sits in a voice channel of the space.
 */
export function announceSpaceRolesChanged(spaceId: string, affectedUserIds: readonly string[]): void {
  connectionManager.announceSpaceAccessChange(spaceId, affectedUserIds);
}

/**
 * Adds a user to a space: the member row, the live WS registration and the
 * `member_joined` broadcast. Callers must have checked bans, duplicates and
 * the visibility/permission rules for their entry path.
 */
export function addUserToSpace(spaceId: string, userId: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(schema.spaceMembers).values({ spaceId, userId, joinedAt: now }).run();

  // Register the user so a connected session receives this space's broadcasts.
  connectionManager.addUserSpace(userId, spaceId);

  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return;
  const member: MemberWithUser = {
    spaceId,
    userId,
    nickname: null,
    joinedAt: now,
    user: sanitizeUser(user),
    roles: [],
  };
  connectionManager.sendToSpace(spaceId, { type: 'member_joined', spaceId, member });
}

/**
 * Adds a bot to a space as a manager does it: the membership (`addUserToSpace`)
 * and, when `permissions` grants anything, the bot's managed role carrying
 * them (utils/botRoles.ts), announced to the space. The caller has checked
 * the grant against the bot's requested permissions and its own.
 */
export function addBotToSpace(
  spaceId: string,
  bot: { id: string; displayName: string | null; username: string },
  permissions: bigint,
): void {
  addUserToSpace(spaceId, bot.id);
  if (permissions === 0n) return;
  createManagedBotRole(spaceId, bot, permissions);
  announceSpaceRolesChanged(spaceId, [bot.id]);
}

/**
 * Takes a user out of a space: the member row, their voice restrictions and
 * read states for the space's channels, then a `member_left` broadcast and the
 * end of live delivery of that space's events to their sockets. A bot also
 * loses its role assignments, its per-member channel overrides and its
 * managed role here: a bot leaves nothing behind (a person keeps their roles,
 * as before). The broadcast
 * goes first so the removed user's own sessions still learn they are out.
 * Callers have checked who may remove whom.
 */
export function removeUserFromSpace(spaceId: string, userId: string): void {
  const db = getDb();
  db.delete(schema.spaceMembers)
    .where(and(eq(schema.spaceMembers.spaceId, spaceId), eq(schema.spaceMembers.userId, userId)))
    .run();

  // Clean up any voice restrictions for the removed member
  db.delete(schema.voiceRestrictions)
    .where(and(eq(schema.voiceRestrictions.spaceId, spaceId), eq(schema.voiceRestrictions.userId, userId)))
    .run();

  // Clean up read_states for the departing user in this space's channels
  const spaceChannelIds = db.select({ id: schema.channels.id })
    .from(schema.channels).where(eq(schema.channels.spaceId, spaceId)).all().map(c => c.id);
  if (spaceChannelIds.length > 0) {
    db.delete(schema.readStates).where(and(
      eq(schema.readStates.userId, userId),
      inArray(schema.readStates.channelId, spaceChannelIds),
    )).run();
  }

  const account = db.select({ isBot: schema.users.isBot }).from(schema.users)
    .where(eq(schema.users.id, userId)).get();
  let managedRoleRemoved = false;
  if (account?.isBot === 1) {
    managedRoleRemoved = deleteManagedBotRole(spaceId, userId);
    if (spaceChannelIds.length > 0) {
      db.delete(schema.botSeatRestrictions).where(and(
        eq(schema.botSeatRestrictions.botId, userId),
        inArray(schema.botSeatRestrictions.channelId, spaceChannelIds),
      )).run();
    }
    db.delete(schema.memberRoles)
      .where(and(eq(schema.memberRoles.spaceId, spaceId), eq(schema.memberRoles.userId, userId)))
      .run();
    if (spaceChannelIds.length > 0) {
      db.delete(schema.channelOverrides).where(and(
        eq(schema.channelOverrides.targetType, 'member'),
        eq(schema.channelOverrides.targetId, userId),
        inArray(schema.channelOverrides.channelId, spaceChannelIds),
      )).run();
    }
  }

  connectionManager.sendToSpace(spaceId, { type: 'member_left', spaceId, userId });
  connectionManager.removeUserSpace(userId, spaceId);
  if (managedRoleRemoved) announceSpaceRolesChanged(spaceId, []);
}
