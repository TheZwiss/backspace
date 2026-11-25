import type { FederationProfileUpdatePayload } from '@backspace/shared';
import type { schema } from '../db/index.js';
import { getOurOrigin } from './federationAuth.js';
import { appendMutationLog, isFederationRelayEnabled, queueOutboxEvent } from './federationOutbox.js';
import { parseStoredBotActivity } from './botActivity.js';
import { storedRequestedPermissions } from './botRoles.js';

type UserRow = typeof schema.users.$inferSelect;

function assetUrl(origin: string, value: string | null): string | null {
  if (!value) return null;
  return value.startsWith('http') ? value : `${origin}/api/uploads/${value}`;
}

/**
 * Queues a `profile_update` to every active peer for a NATIVE user whose
 * durable profile fields just changed. The home instance is authoritative;
 * peers apply it to the account that IS this identity, including a bot's
 * federated account on a host. Caller must have stamped `profileUpdatedAt`
 * (the receiver rejects a version that is not newer).
 */
export function queueProfileUpdateRelay(user: UserRow): void {
  if (user.homeInstance || !isFederationRelayEnabled()) return;
  const origin = getOurOrigin();
  const payload: FederationProfileUpdatePayload = {
    homeUserId: user.id,
    homeInstance: origin,
    profileUpdatedAt: user.profileUpdatedAt ?? Date.now(),
    username: user.username,
    displayName: user.displayName,
    avatar: assetUrl(origin, user.avatar),
    banner: assetUrl(origin, user.banner),
    accentColor: user.accentColor,
    avatarColor: user.avatarColor,
    bio: user.bio,
    // A bot's stored status is part of its profile, so a host's federated
    // account of the bot shows it too. Null when cleared; absent for people.
    // Its requested permissions too, so a manager there can add it with them.
    ...(user.isBot === 1
      ? {
        botActivity: parseStoredBotActivity(user.botActivity),
        botRequestedPermissions: storedRequestedPermissions(user.botRequestedPermissions).toString(),
      }
      : {}),
  };
  const body = JSON.stringify({ profileUpdate: payload });
  appendMutationLog(user.id, user.id, 'profile_update', body, 'profile');
  // entityId = user id (coalesces rapid edits); no target list = all active peers.
  queueOutboxEvent(user.id, user.id, 'profile_update', body, undefined, 'profile');
}
