import type { AvatarColor } from '@backspace/shared';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { validateExternalUrl } from './ssrf.js';

export interface SpaceInviteSnapshot {
  spaceId: string;
  spaceName: string;
  description: string | null;
  icon: string | null;
  avatarColor: AvatarColor | null;
  memberCount: number;
  instanceName: string;
}

/**
 * Build a local invite snapshot directly from the DB. Used when the space
 * lives on this instance — avoids an HTTP roundtrip through our own domain
 * (which fails inside Docker due to NAT loopback) and is faster anyway.
 *
 * Returns the same shape as `fetchSpaceInviteSnapshot` so callers don't
 * branch downstream of the snapshot lookup.
 */
export function getLocalInviteSnapshot(inviteCode: string): SpaceInviteSnapshot | null {
  const db = getDb();
  const space = db.select().from(schema.spaces)
    .where(eq(schema.spaces.inviteCode, inviteCode)).get();
  if (!space) return null;

  const memberCount = db.select().from(schema.spaceMembers)
    .where(eq(schema.spaceMembers.spaceId, space.id)).all().length;

  const settings = db.select().from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.id, 1)).get();
  const instanceName = settings?.instanceName ?? 'Backspace';

  return {
    spaceId: space.id,
    spaceName: space.name,
    description: space.description ?? null,
    icon: space.icon ?? null,
    avatarColor: (space.avatarColor as AvatarColor | null) ?? null,
    memberCount,
    instanceName,
  };
}

/**
 * Fetch a space invite preview from a (possibly remote) instance.
 * Returns null on 4xx, network error, or timeout — caller should treat as
 * "invite no longer valid".
 *
 * Uses a 5s default timeout so a slow/unreachable Z does not stall the
 * caller-instance request.
 */
export async function fetchSpaceInviteSnapshot(
  spaceInstanceOrigin: string,
  inviteCode: string,
  timeoutMs = 5000,
): Promise<SpaceInviteSnapshot | null> {
  const url = `${spaceInstanceOrigin}/api/spaces/invite/${encodeURIComponent(inviteCode)}/preview`;
  try {
    await validateExternalUrl(url);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json() as Partial<SpaceInviteSnapshot>;
    if (typeof data?.spaceId !== 'string' || typeof data?.spaceName !== 'string') return null;
    return {
      spaceId: data.spaceId,
      spaceName: data.spaceName,
      description: data.description ?? null,
      icon: data.icon ?? null,
      avatarColor: data.avatarColor ?? null,
      memberCount: typeof data.memberCount === 'number' ? data.memberCount : 0,
      instanceName: data.instanceName ?? 'Backspace',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
