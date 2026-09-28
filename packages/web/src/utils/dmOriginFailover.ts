import { useChatStore } from '../stores/chatStore';
import type { DmPinMove } from '../stores/dmConversations';

/**
 * The effect of a DM pin move: the chat state and the URL of a row follow it
 * from its old channel id to its new one.
 *
 * Which copy of a conversation is pinned is decided in one place, the pin
 * rule of `stores/dmConversations.ts` (home copy first, then the current pin
 * while it is reachable, then the first reachable copy). A pin moves on
 * failover (`setDmOriginAvailable(origin, false)` when a remote socket drops),
 * when the home copy arrives after a sibling's, when an instance is removed
 * (`dropOrigin`), and when an entry the client made for an unplaced message
 * turns out to be a copy of a listed conversation. `spaceStore` applies the
 * moves every operation reports through this function, after it has stored
 * the new state.
 *
 * - `chatStore.rekeyChannelState(from, to)` drops the old id's messages and
 *   channel-keyed state (message ids are local to the instance that issued
 *   them, so the view re-fetches from the new origin) and carries the unread
 *   flag and the current selection over.
 * - When the user is viewing the moved row, the last path segment is swapped
 *   in place with `history.replaceState`. No router navigation: the chat view
 *   re-renders from the updated `currentChannelId`.
 *
 * Voice state (activeDmCall / outgoingCall / incomingCall) is intentionally
 * NOT rewritten: a LiveKit session bound to the old origin cannot migrate;
 * voice cleans up through its own disconnect paths.
 */
export function applyDmPinMoves(moves: readonly DmPinMove[]): void {
  for (const move of moves) {
    useChatStore.getState().rekeyChannelState(move.fromChannelId, move.toChannelId);
    replaceDmIdInUrl(move.fromChannelId, move.toChannelId);
  }
}

function replaceDmIdInUrl(oldId: string, newId: string): void {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  const marker = '/channels/@me/';
  const idx = path.indexOf(marker);
  if (idx === -1 || path.slice(idx + marker.length) !== oldId) return;
  const nextPath = path.slice(0, idx + marker.length) + newId;
  window.history.replaceState(window.history.state, '', nextPath + window.location.search);
}
