import type { StateCreator } from 'zustand';
import type { SpaceFolder, SpaceLayoutItem } from '@backspace/shared';
import { api, type BackspaceApiClient } from '../api/client';
import { getApiForOrigin } from '../utils/crossStoreResolvers';
import type { SpaceState } from './spaceStoreTypes';

/**
 * Push the current layout to a specific origin whose layout was older.
 * Used when populateFromReady receives a stale layout from an instance.
 */
export async function pushLayoutToOrigin(
  origin: string,
  layout: SpaceLayoutItem[] | null,
  folders: SpaceFolder[],
  updatedAt: number,
): Promise<void> {
  try {
    const targetApi = getApiForOrigin(origin);
    const folderMap: Record<string, { name: string | null; color: string | null; spaceIds: string[] }> = {};
    for (const f of folders) {
      folderMap[f.id] = { name: f.name, color: f.color, spaceIds: f.spaceIds };
    }
    await targetApi.spaceLayout.update({
      items: layout ?? [],
      folders: folderMap,
      updatedAt,
    });
  } catch (err) {
    console.warn(`[SpaceStore] Failed to push layout to ${origin || 'home'}:`, err);
  }
}

export const createSpaceLayoutSlice: StateCreator<SpaceState, [], [], Pick<SpaceState, 'setSpaceLayout' | 'updateSpaceLayout'>> = (set) => ({
  setSpaceLayout: (layout) => set({ spaceLayout: layout }),

  updateSpaceLayout: async (items, folders) => {
    const now = Date.now();
    // Optimistic: apply the layout immediately with new timestamp
    set({ spaceLayout: items, _layoutUpdatedAt: now });

    // Push to ALL connected instances in parallel (browsing + remotes)
    const targets: { origin: string; apiClient: BackspaceApiClient }[] = [
      { origin: '', apiClient: api },
    ];

    // Dynamically import instanceStore to avoid circular dep
    try {
      const { useInstanceStore } = await import('./instanceStore');
      const connected = useInstanceStore.getState().instances.filter(i => i.status === 'connected');
      for (const inst of connected) {
        targets.push({ origin: inst.origin, apiClient: inst.api });
      }
    } catch { /* instanceStore not available yet */ }

    const results = await Promise.allSettled(
      targets.map(t => t.apiClient.spaceLayout.update({ items, folders, updatedAt: now }))
    );

    // Use the first successful response to resolve new:* IDs
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const resolved = result.value;
        set({
          spaceLayout: resolved.items,
          folders: resolved.folders,
          _layoutUpdatedAt: resolved.updatedAt ?? now,
        });
        break;
      }
    }
  },
});
