import type { DmChannel } from '@backspace/shared';

/**
 * Where a DM channel id sits in the client's DM list.
 *
 * A conversation can be held by several instances, each under its own local
 * id. The client lists it once, under one pinned copy (`dmChannels`), and
 * records every other instance's id for it in `dmAlternatives`.
 *
 * - `pinned`: the id is the listed entry's own id. Ids written under it are
 *   the pinned origin's, and `dm.members` are read as its people.
 * - `alternate`: the id is `origin`'s id for the listed conversation `dm`.
 *   Ids written under it are `origin`'s ids. The client holds no member list
 *   for that copy, so no user id under an alternate id is read against
 *   `dm.members`.
 *
 * `dm.members` is the member list of the first copy the client saw. Reading
 * it in the pinned origin's ids assumes the two are the same copy, which a
 * rekey breaks (`rekeyDmChannel` in `utils/dmOriginFailover.ts` moves the id
 * and origin and keeps the members). One entry per copy is the direction of
 * ADR 0001 (`docs/decisions/0001-dm-conversation-identity.md`).
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
