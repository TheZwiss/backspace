import type { DmChannel } from '@backspace/shared';

/**
 * Sort DM channels: unread first (by recency), then read (by recency).
 * Does not mutate the input array.
 *
 * @param dmChannels - The DM channels to sort
 * @param unreadChannels - Set of channel IDs that have unread messages
 * @param currentChannelId - The currently active channel (excluded from unread group)
 */
export function sortDmChannels(
  dmChannels: DmChannel[],
  unreadChannels: Set<string>,
  currentChannelId: string | null,
): DmChannel[] {
  const getTime = (dm: DmChannel) => dm.lastMessage?.createdAt ?? dm.createdAt;
  const isUnread = (dm: DmChannel) => unreadChannels.has(dm.id) && dm.id !== currentChannelId;

  const unread: DmChannel[] = [];
  const read: DmChannel[] = [];

  for (const dm of dmChannels) {
    if (isUnread(dm)) {
      unread.push(dm);
    } else {
      read.push(dm);
    }
  }

  const byRecency = (a: DmChannel, b: DmChannel) => getTime(b) - getTime(a);
  unread.sort(byRecency);
  read.sort(byRecency);

  return [...unread, ...read];
}
