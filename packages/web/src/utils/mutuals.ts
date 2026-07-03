import type { User } from '@backspace/shared';
import { api } from '../api/client';
import { useInstanceStore } from '../stores/instanceStore';
import { normalizeUserAssets, resolveAssetUrl } from './assetUrls';

// ─── Tagged types ────────────────────────────────────────────────────────────

export type TaggedMutualFriend = User & { _instanceOrigin: string };

export interface MutualSpace {
  id: string;
  name: string;
  icon: string | null;
  avatarColor: string | null;
  _instanceOrigin: string;
}

export interface FederatedMutuals {
  mutualFriends: TaggedMutualFriend[];
  mutualSpaces: MutualSpace[];
}

// ─── Federation fan-out ──────────────────────────────────────────────────────

/**
 * Load mutual friends and mutual spaces across all connected instances.
 * Follows the same Promise.allSettled fan-out pattern as socialStore.loadFriends().
 *
 * - Waits for auto-connect to finish before fanning out (same guard as socialStore)
 * - Deduplicates friends by canonical identity (homeUserId ?? id)
 * - Concatenates spaces (spaces on different instances are distinct)
 * - Normalizes assets for remote-origin results
 */
export async function loadFederatedMutuals(
  targetUserId: string,
  targetHomeUserId?: string | null,
): Promise<FederatedMutuals> {
  // Wait for all remote connections to establish before fanning out
  if (!useInstanceStore.getState()._autoConnectDone) {
    await new Promise<void>((resolve) => {
      const unsub = useInstanceStore.subscribe((state) => {
        if (state._autoConnectDone) {
          unsub();
          resolve();
        }
      });
      // Double-check (race condition guard)
      if (useInstanceStore.getState()._autoConnectDone) {
        unsub();
        resolve();
      }
    });
  }

  // Lazy import — avoids pulling spaceStore's transitive dependency chain into
  // test environments that don't set up AudioWorkletNode.
  const { useSpaceStore } = await import('../stores/spaceStore');

  const instances = useInstanceStore.getState().instances;
  const connectedInstances = instances.filter(i => i.status === 'connected');

  const canonicalHomeId = targetHomeUserId ?? targetUserId;

  const results = await Promise.allSettled([
    api.users.getMutuals(targetUserId, canonicalHomeId)
      .then(data => ({ data, origin: '' })),
    ...connectedInstances.map(inst =>
      inst.api.users.getMutuals(targetUserId, canonicalHomeId)
        .then(data => ({ data, origin: inst.origin }))
    ),
  ]);

  const allFriends: TaggedMutualFriend[] = [];
  const seenFriends = new Set<string>();
  const allSpaces: MutualSpace[] = [];
  const seenSpaces = new Set<string>();

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { data, origin } = result.value;

    // Deduplicate friends by canonical identity (homeUserId ?? id)
    for (const friend of data.mutualFriends) {
      const canonicalId = friend.homeUserId ?? friend.id;
      if (seenFriends.has(canonicalId)) continue;
      seenFriends.add(canonicalId);
      if (origin) normalizeUserAssets(friend, origin);
      allFriends.push({ ...friend, _instanceOrigin: origin });
      useSpaceStore.getState().upsertUserView(friend, origin);
    }

    // Spaces on different instances are distinct — deduplicate within same origin
    for (const space of data.mutualSpaces) {
      const key = `${space.id}:${origin}`;
      if (seenSpaces.has(key)) continue;
      seenSpaces.add(key);
      const icon = origin ? (resolveAssetUrl(space.icon, origin) ?? space.icon) : space.icon;
      allSpaces.push({ ...space, icon, _instanceOrigin: origin });
    }
  }

  return { mutualFriends: allFriends, mutualSpaces: allSpaces };
}
