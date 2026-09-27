import { useSpaceStore, getLayoutHomeOrigin } from '../stores/spaceStore';
import { useChatStore } from '../stores/chatStore';
import { useInstanceStore } from '../stores/instanceStore';

/**
 * DM origin failover: when a remote instance disconnects mid-session,
 * re-point every DM pinned to it onto a connected sibling that holds the
 * same federated DM (via S2S mirroring). See
 * `docs/superpowers/specs/2026-04-23-dm-origin-failover-design.md`.
 *
 * No-op when:
 *  - no DMs are pinned to the disconnected origin
 *  - pinned DMs have no `federatedId` (never-federated)
 *  - no alternative origin is currently connected
 *
 * Voice state (activeDmCall / outgoingCall / incomingCall) is intentionally
 * NOT rewritten — a LiveKit session bound to the disconnected origin cannot
 * migrate; voice cleans up through its own disconnect paths.
 */
export function failoverDmOriginsFromDisconnected(disconnectedOrigin: string): void {
  const spaceState = useSpaceStore.getState();
  const { dmChannels, channelOriginMap, dmAlternatives } = spaceState;

  // Build the set of connected-origin candidates (home is always considered
  // connected while auth is live — its WS disconnect path doesn't go through
  // instanceStore at all).
  const instances = useInstanceStore.getState().instances;
  const connectedRemotes = new Set(
    instances.filter(i => i.status === 'connected').map(i => i.origin),
  );
  const isOriginConnected = (o: string): boolean => o === '' || connectedRemotes.has(o);

  type Rekey = { oldId: string; newId: string; newOrigin: string; federatedId: string };
  const rekeys: Rekey[] = [];

  for (const dm of dmChannels) {
    if (channelOriginMap.get(dm.id) !== disconnectedOrigin) continue;
    if (!dm.federatedId) continue;

    const byOrigin = dmAlternatives.get(dm.federatedId);
    if (!byOrigin) continue;

    // Preference order: home ('') first, then any connected remote in
    // insertion order (Map preserves insertion order in ES2015+).
    let chosenOrigin: string | null = null;
    let chosenLocalId: string | null = null;
    if (byOrigin.has('') && isOriginConnected('') && '' !== disconnectedOrigin) {
      chosenOrigin = '';
      chosenLocalId = byOrigin.get('')!;
    } else {
      for (const [altOrigin, altLocalId] of byOrigin) {
        if (altOrigin === disconnectedOrigin) continue;
        if (!isOriginConnected(altOrigin)) continue;
        chosenOrigin = altOrigin;
        chosenLocalId = altLocalId;
        break;
      }
    }
    if (chosenOrigin === null || chosenLocalId === null) continue;
    if (chosenLocalId === dm.id) continue; // shouldn't happen, but guard

    rekeys.push({
      oldId: dm.id,
      newId: chosenLocalId,
      newOrigin: chosenOrigin,
      federatedId: dm.federatedId,
    });
  }

  if (rekeys.length === 0) return;

  for (const r of rekeys) {
    rekeyDmChannel(r.oldId, r.newId, r.newOrigin, r.federatedId);
  }
}

/**
 * Atomic rename of a DM across spaceStore + chatStore + URL.
 * Exported for unit tests; not part of the public failover API.
 */
export function rekeyDmChannel(
  oldId: string,
  newId: string,
  newOrigin: string,
  federatedId: string,
): void {
  useSpaceStore.setState((state) => {
    const dmChannels = state.dmChannels.map(dm =>
      dm.id === oldId ? { ...dm, id: newId } : dm,
    );

    const channelOriginMap = new Map(state.channelOriginMap);
    channelOriginMap.delete(oldId);
    channelOriginMap.set(newId, newOrigin);

    const channelLastMessageIds = new Map(state.channelLastMessageIds);
    channelLastMessageIds.delete(oldId); // old id's stored last-message id is origin-local

    // dmAlternatives update: remove the chosen origin's entry from the inner map
    // (it IS the primary now — not an alternative), but RETAIN every other origin's
    // entry including the old origin (so a later fail-back can use it without
    // needing another ready round-trip).
    const dmAlternatives = new Map<string, Map<string, string>>();
    for (const [fid, byOrigin] of state.dmAlternatives) {
      const next = new Map(byOrigin);
      if (fid === federatedId) next.delete(newOrigin);
      if (next.size > 0) dmAlternatives.set(fid, next);
    }

    return { dmChannels, channelOriginMap, channelLastMessageIds, dmAlternatives };
  });

  useChatStore.getState().rekeyChannelState(oldId, newId);

  // URL update: if the user is viewing the DM whose id just changed, swap the
  // last path segment in place. No router navigation — the chat view re-renders
  // from the updated currentChannelId.
  if (typeof window !== 'undefined') {
    const path = window.location.pathname;
    const marker = `/channels/@me/`;
    const idx = path.indexOf(marker);
    if (idx !== -1 && path.slice(idx + marker.length) === oldId) {
      const nextPath = path.slice(0, idx + marker.length) + newId;
      window.history.replaceState(window.history.state, '', nextPath + window.location.search);
    }
  }
}

/**
 * Pin every federated DM to the copy held by the user's home instance, when
 * this client has seen that copy (it is in `dmAlternatives`).
 *
 * The first copy of a conversation to reach the client becomes the listed
 * entry, and only that pinned copy's messages enter its message list (see
 * `utils/dmMessageRouting.ts`). Relays only go to instances that host a
 * participant, and the user's home always hosts one; a sibling instance the
 * user merely has an account on may host nobody. A DM created through such a
 * sibling was announced by it first and stayed pinned there, so the other
 * person's replies, relayed to home only, never appeared live. Called after
 * every path that records a copy: a `ready` payload, a DM-list reload, and
 * `dm_channel_created`.
 *
 * The home is `getLayoutHomeOrigin()`: '' for a user native to the browsed
 * instance, or the connected remote that is the account's true home.
 */
export function repinDmsToHomeCopies(): void {
  const home = getLayoutHomeOrigin();
  const { dmChannels, channelOriginMap, dmAlternatives } = useSpaceStore.getState();

  const rekeys: Array<{ oldId: string; newId: string; federatedId: string }> = [];
  for (const dm of dmChannels) {
    if (!dm.federatedId) continue;
    if ((channelOriginMap.get(dm.id) ?? '') === home) continue;
    const homeId = dmAlternatives.get(dm.federatedId)?.get(home);
    if (!homeId || homeId === dm.id) continue;
    if (dmChannels.some(other => other.id === homeId)) continue;
    rekeys.push({ oldId: dm.id, newId: homeId, federatedId: dm.federatedId });
  }

  for (const r of rekeys) {
    rekeyDmChannel(r.oldId, r.newId, home, r.federatedId);
  }
}
