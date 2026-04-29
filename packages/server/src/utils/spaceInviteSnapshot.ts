import type { AvatarColor } from '@backspace/shared';
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
