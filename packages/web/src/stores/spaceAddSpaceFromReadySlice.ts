import type { SpaceWithChannelsAndMembers } from '@backspace/shared';
import { resolveAssetUrl } from '../utils/assetUrls';

import type { StateCreator } from 'zustand';
import { type TaggedSpace } from './spaceStore';
import type { SpaceState } from './spaceStoreTypes';

export const createAddSpaceFromReadySlice: StateCreator<SpaceState, [], [], Pick<SpaceState, 'addSpaceFromReady'>> = (set, get) => ({
  addSpaceFromReady: (origin: string, space: SpaceWithChannelsAndMembers) => {
    // Normalize remote asset URLs before creating the tagged object
    if (origin) {
      if (space.icon) space.icon = resolveAssetUrl(space.icon, origin) ?? space.icon;
      if (space.banner) space.banner = resolveAssetUrl(space.banner, origin) ?? space.banner;
    }

    const tagged: TaggedSpace = {
      id: space.id,
      name: space.name,
      icon: space.icon,
      banner: space.banner ?? null,
      avatarColor: space.avatarColor ?? null,
      ownerId: space.ownerId,
      ownerTitle: space.ownerTitle,
      inviteCode: space.inviteCode,
      visibility: space.visibility,
      directoryListed: space.directoryListed ?? false,
      description: space.description,
      createdAt: space.createdAt,
      _instanceOrigin: origin,
    };

    const channelToSpaceMap = new Map(get().channelToSpaceMap);
    const channelLastMessageIds = new Map(get().channelLastMessageIds);
    const spacePermissions = new Map(get().spacePermissions);
    const channelPermissions = new Map(get().channelPermissions);
    const channelOriginMap = new Map(get().channelOriginMap);

    if (space.myPermissions) {
      spacePermissions.set(space.id, space.myPermissions);
    }
    for (const ch of space.channels) {
      channelToSpaceMap.set(ch.id, space.id);
      channelOriginMap.set(ch.id, origin);
      if (ch.lastMessageId) {
        channelLastMessageIds.set(ch.id, ch.lastMessageId);
      }
      if (ch.myPermissions) {
        channelPermissions.set(ch.id, ch.myPermissions);
      }
    }

    set((state) => ({
      spaces: [...state.spaces.filter(s => s.id !== space.id), tagged],
      channelToSpaceMap,
      channelLastMessageIds,
      spacePermissions,
      channelPermissions,
      channelOriginMap,
    }));
  },

});
