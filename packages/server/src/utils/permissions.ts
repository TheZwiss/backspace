import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { MemberRole } from '@opencord/shared';

export function getMember(serverId: string, userId: string) {
  const db = getDb();
  return db.select().from(schema.serverMembers)
    .where(and(
      eq(schema.serverMembers.serverId, serverId),
      eq(schema.serverMembers.userId, userId),
    ))
    .get();
}

export function isMember(serverId: string, userId: string): boolean {
  return getMember(serverId, userId) !== undefined;
}

export function getMemberRole(serverId: string, userId: string): MemberRole | null {
  const member = getMember(serverId, userId);
  return member ? (member.role as MemberRole) : null;
}

export function isOwner(serverId: string, userId: string): boolean {
  const role = getMemberRole(serverId, userId);
  return role === 'owner';
}

export function isAdmin(serverId: string, userId: string): boolean {
  const role = getMemberRole(serverId, userId);
  return role === 'owner' || role === 'admin';
}

export function isServerOwner(serverId: string, userId: string): boolean {
  const db = getDb();
  const server = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
  return server?.ownerId === userId;
}

export function getChannelServerId(channelId: string): string | null {
  const db = getDb();
  const channel = db.select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
  return channel?.serverId ?? null;
}

export function isDmMember(dmChannelId: string, userId: string): boolean {
  const db = getDb();
  const member = db.select().from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, dmChannelId),
      eq(schema.dmMembers.userId, userId),
    ))
    .get();
  return member !== undefined;
}
