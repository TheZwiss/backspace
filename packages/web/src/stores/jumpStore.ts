import { create } from 'zustand';
import i18n from '../i18n';
import { resolveDmChannelId, useSpaceStore } from './spaceStore';
import { useUIStore } from './uiStore';

/**
 * A request to open a conversation at one message, from outside the message
 * list: a search result, a bookmark. The store only carries the request. The
 * address bar decides which conversation is open (`useJumpNavigation` writes
 * it), and the list that shows the conversation takes the request once it is
 * the current one (`useActiveJump`) and runs its own jump
 * (`MessageList.jumpToMessage`: `loadMessagesAround`, highlight, and its own
 * "message unavailable" toast for a message that is gone).
 */

/** Where a message lives, as the caller knows it. A DM is named by any of its copies' channel ids. */
export type JumpTarget =
  | { kind: 'channel'; spaceId: string; channelId: string }
  | { kind: 'dm'; channelId: string };

export interface JumpRequest {
  /** The route's space segment: the space id, or `@me` for a DM. */
  spaceId: string;
  /** The channel id the client opens: the row a DM is pinned to, not necessarily the id the caller gave. */
  channelId: string;
  messageId: string;
  /** Distinguishes two requests for the same message, so the second runs too. */
  seq: number;
  /** A request nobody took by then is dropped: the conversation never opened (left the space, channel removed). */
  expiresAt: number;
}

/** How long a request waits for its conversation to open. */
export const JUMP_REQUEST_TTL_MS = 15_000;

interface JumpState {
  request: JumpRequest | null;
  /**
   * Ask for `messageId` of `target`. False, with the "message unavailable"
   * toast shown, when this client has no such conversation: the space is not
   * one the user belongs to, or the DM is not in their list.
   */
  requestJump: (target: JumpTarget, messageId: string) => boolean;
  clearJump: () => void;
}

let nextSeq = 1;

function resolve(target: JumpTarget): { spaceId: string; channelId: string } | null {
  if (target.kind === 'dm') {
    const channelId = resolveDmChannelId(target.channelId);
    return channelId ? { spaceId: '@me', channelId } : null;
  }
  const inSpace = useSpaceStore.getState().spaces.some((space) => space.id === target.spaceId);
  return inSpace ? { spaceId: target.spaceId, channelId: target.channelId } : null;
}

export const useJumpStore = create<JumpState>((set) => ({
  request: null,

  requestJump: (target, messageId) => {
    const resolved = resolve(target);
    if (!resolved) {
      useUIStore.getState().addToast(i18n.t('chat:list.jump.unavailable'), 'info', 4000);
      return false;
    }
    set({ request: { ...resolved, messageId, seq: nextSeq++, expiresAt: Date.now() + JUMP_REQUEST_TTL_MS } });
    return true;
  },

  clearJump: () => set({ request: null }),
}));

/** The message the list of `channelId` should jump to now, or null. */
export function useActiveJump(channelId: string | null | undefined): string | null {
  return useJumpStore((state) => {
    const { request } = state;
    if (!request || !channelId || request.channelId !== channelId) return null;
    return Date.now() < request.expiresAt ? request.messageId : null;
  });
}
