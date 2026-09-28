import type { DmChannel } from '@backspace/shared';

/**
 * Where a DM channel id sits in the client's DM list.
 *
 * A conversation can be held by several instances, each under its own local
 * id. The DM merge module (`stores/dmConversations.ts`, ADR 0002,
 * `docs/decisions/0002-dm-conversation-identity.md`) keeps every copy and
 * pins one per conversation. The client lists the pinned copy (`dmChannels`)
 * and indexes every copy of a keyed conversation by origin (`dmAlternatives`);
 * both are derived from the module's state.
 *
 * - `pinned`: the id is the listed entry's own id. Ids written under it are
 *   the pinned origin's, and `dm.members` are the pinned copy's own members,
 *   read as that origin's people.
 * - `alternate`: the id is `origin`'s id for the listed conversation `dm`.
 *   Ids written under it are `origin`'s ids, and `dm.members` are the pinned
 *   copy's, not `origin`'s, so no user id under an alternate id is read
 *   against them.
 */
export type DmChannelLocation =
  | { kind: 'pinned'; dm: DmChannel }
  | { kind: 'alternate'; dm: DmChannel; origin: string };

/**
 * Locate `rawId` among the listed DMs and their recorded alternate ids. Null
 * when the id is unknown, or when it is an alternate id of a conversation
 * that is no longer listed.
 *
 * Pure over the given slices, so both the store's `resolveDmChannelId` and
 * render-time derivations (`utils/channelUser`) share it.
 */
export function locateDmChannel(
  dmChannels: readonly DmChannel[],
  dmAlternatives: ReadonlyMap<string, ReadonlyMap<string, string>>,
  rawId: string,
): DmChannelLocation | null {
  const pinned = dmChannels.find((dm) => dm.id === rawId);
  if (pinned) return { kind: 'pinned', dm: pinned };

  for (const [federatedId, byOrigin] of dmAlternatives) {
    for (const [origin, localId] of byOrigin) {
      if (localId !== rawId) continue;
      const primary = dmChannels.find((dm) => dm.federatedId === federatedId);
      return primary ? { kind: 'alternate', dm: primary, origin } : null;
    }
  }
  return null;
}
