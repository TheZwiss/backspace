import type { TaggedFriend } from '../stores/socialStore';
import type { TaggedSpace } from '../stores/spaceStore';
import type { SpaceChannelIndex } from '../stores/spaceChannels';
import { deliveringHost, userKey } from './identity';

export function groupFriendsInVoice(friends: readonly TaggedFriend[], voiceUsers: ReadonlyMap<string, string[]>, index: SpaceChannelIndex, spaces: readonly TaggedSpace[]) {
  const friendsByRow = new Map<string, TaggedFriend>();
  for (const friend of friends) {
    for (const row of friend._rows ?? [friend]) friendsByRow.set(`${deliveringHost(row._instanceOrigin)}:${row.id}`, friend);
  }
  const groups = [];
  for (const [channelId, ids] of voiceUsers) {
    const channel = index.get(channelId);
    if (!channel || channel.type !== 'voice' || !channel.name) continue;
    const space = spaces.find(s => s.id === channel.spaceId && deliveringHost(s._instanceOrigin) === deliveringHost(channel.origin));
    if (!space) continue;
    const seen = new Set<string>();
    const members: TaggedFriend[] = [];
    for (const id of ids) {
      const friend = friendsByRow.get(`${deliveringHost(channel.origin)}:${id}`);
      if (!friend) continue;
      const key = userKey(friend, friend._instanceOrigin);
      if (seen.has(key)) continue;
      seen.add(key); members.push(friend);
    }
    if (members.length) groups.push({ channelId, channelName: channel.name, space, friends: members });
  }
  return groups.sort((a, b) => a.space.name.localeCompare(b.space.name) || a.channelName.localeCompare(b.channelName));
}
