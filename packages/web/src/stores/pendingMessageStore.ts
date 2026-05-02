import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import type { MessageWithUser, Attachment } from '@backspace/shared';
import { useTransferStore } from './transferStore';

export type PendingBubbleState = 'sending' | 'failed';

export interface PendingBubble {
  clientId: string;
  channelId: string;
  content: string;
  replyToId: string | null;
  transferIds: string[];
  createdAtLocal: number;
  state: PendingBubbleState;
  tusExpiresAt: number;
  retryCount: number;
}

interface PendingMessageStoreState {
  bubbles: Map<string, PendingBubble[]>; // channelId → bubbles
}

interface PendingMessageStoreActions {
  append: (b: PendingBubble) => void;
  removeByClientId: (channelId: string, clientId: string) => void;
  markFailed: (clientId: string) => void;
  markSending: (clientId: string) => void;
  bumpRetry: (clientId: string) => void;
  listForChannel: (channelId: string) => PendingBubble[];
  matchAndRemove: (
    channelId: string,
    content: string,
    sortedAttachmentIds: string[],
  ) => PendingBubble | null;
  discardExpired: (now: number) => PendingBubble[];
  listReadyForDeferredSend: () => PendingBubble[];
  listFailedRetryable: () => PendingBubble[];
}

type PendingMessageStore = PendingMessageStoreState & PendingMessageStoreActions;

function findBubble(
  map: Map<string, PendingBubble[]>,
  clientId: string,
): { ch: string; bubble: PendingBubble } | null {
  for (const [ch, list] of map) {
    const b = list.find((x) => x.clientId === clientId);
    if (b) return { ch, bubble: b };
  }
  return null;
}

function setBubble(
  map: Map<string, PendingBubble[]>,
  clientId: string,
  mut: (b: PendingBubble) => PendingBubble,
): Map<string, PendingBubble[]> {
  const found = findBubble(map, clientId);
  if (!found) return map;
  const next = new Map(map);
  const list = next.get(found.ch) ?? [];
  next.set(
    found.ch,
    list.map((b) => (b.clientId === clientId ? mut(b) : b)),
  );
  return next;
}

// Custom storage that serializes Map<string, PendingBubble[]> as an array of entries.
// Mirrors composerStore's mapAwareStorage; only the `bubbles` slice is persisted.
const mapAwareStorage: PersistStorage<Pick<PendingMessageStoreState, 'bubbles'>> = {
  getItem: (name) => {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as {
        state: { bubbles: [string, PendingBubble[]][] };
        version?: number;
      };
      const stateOut: Pick<PendingMessageStoreState, 'bubbles'> = {
        bubbles: new Map<string, PendingBubble[]>(parsed.state.bubbles ?? []),
      };
      return { state: stateOut, version: parsed.version } as StorageValue<
        Pick<PendingMessageStoreState, 'bubbles'>
      >;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (typeof localStorage === 'undefined') return;
    const entries = Array.from(value.state.bubbles.entries());
    const payload = JSON.stringify({ state: { bubbles: entries }, version: value.version });
    try {
      localStorage.setItem(name, payload);
    } catch (err) {
      console.warn(`[pendingMessageStore] persist failed:`, err);
    }
  },
  removeItem: (name) => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(name);
  },
};

export const usePendingMessageStore = create<PendingMessageStore>()(
  persist(
    (set, get) => ({
      bubbles: new Map<string, PendingBubble[]>(),

      append: (b) =>
        set((s) => {
          const next = new Map(s.bubbles);
          next.set(b.channelId, [...(next.get(b.channelId) ?? []), b]);
          return { bubbles: next };
        }),

      removeByClientId: (channelId, clientId) =>
        set((s) => {
          const list = s.bubbles.get(channelId);
          if (!list) return s;
          const next = new Map(s.bubbles);
          next.set(
            channelId,
            list.filter((b) => b.clientId !== clientId),
          );
          return { bubbles: next };
        }),

      markFailed: (clientId) =>
        set((s) => ({
          bubbles: setBubble(s.bubbles, clientId, (b) => ({ ...b, state: 'failed' })),
        })),

      markSending: (clientId) =>
        set((s) => ({
          bubbles: setBubble(s.bubbles, clientId, (b) => ({ ...b, state: 'sending' })),
        })),

      bumpRetry: (clientId) =>
        set((s) => ({
          bubbles: setBubble(s.bubbles, clientId, (b) => ({ ...b, retryCount: b.retryCount + 1 })),
        })),

      listForChannel: (channelId) => get().bubbles.get(channelId) ?? [],

      matchAndRemove: (channelId, content, sortedAttachmentIds) => {
        const list = get().bubbles.get(channelId);
        if (!list) return null;
        const transfers = useTransferStore.getState().transfers;
        const target = [...sortedAttachmentIds].sort();
        const matches = list
          .filter((b) => b.content === content)
          .filter((b) => {
            const ids = b.transferIds
              .map((tid) => transfers.get(tid)?.attachmentId)
              .filter((id): id is string => typeof id === 'string' && id.length > 0);
            const sorted = [...ids].sort();
            return sorted.length === target.length && sorted.every((v, i) => v === target[i]);
          })
          .sort((a, b) => a.createdAtLocal - b.createdAtLocal);
        if (matches.length === 0) return null;
        const winner = matches[0]!;
        get().removeByClientId(channelId, winner.clientId);
        return winner;
      },

      discardExpired: (now) => {
        const map = get().bubbles;
        const dropped: PendingBubble[] = [];
        let mutated = false;
        const next = new Map<string, PendingBubble[]>();
        for (const [ch, list] of map) {
          const surviving: PendingBubble[] = [];
          for (const b of list) {
            if (b.tusExpiresAt < now) {
              dropped.push(b);
              mutated = true;
            } else {
              surviving.push(b);
            }
          }
          if (surviving.length > 0) next.set(ch, surviving);
          else if (list.length > 0) mutated = true; // dropping a non-empty channel entry counts as mutation
        }
        if (mutated) set({ bubbles: next });
        return dropped;
      },

      listReadyForDeferredSend: () => {
        const transfers = useTransferStore.getState().transfers;
        const ready: PendingBubble[] = [];
        for (const list of get().bubbles.values()) {
          for (const b of list) {
            if (b.state !== 'sending') continue;
            const allDone = b.transferIds.every((tid) => {
              const t = transfers.get(tid);
              return t?.state === 'completed' && !!t.attachmentId;
            });
            if (allDone) ready.push(b);
          }
        }
        return ready;
      },

      listFailedRetryable: () => {
        const transfers = useTransferStore.getState().transfers;
        const out: PendingBubble[] = [];
        for (const list of get().bubbles.values()) {
          for (const b of list) {
            if (b.state !== 'failed') continue;
            if (b.retryCount > 0) continue;
            const allDone = b.transferIds.every((tid) => {
              const t = transfers.get(tid);
              return t?.state === 'completed' && !!t.attachmentId;
            });
            if (allDone) out.push(b);
          }
        }
        return out;
      },
    }),
    {
      name: 'pendingMessageStore@v1',
      version: 1,
      storage: mapAwareStorage,
      partialize: (s) => ({ bubbles: s.bubbles }),
    },
  ),
);

// ─── Synthesized view types for MessageList rendering ───────────────────────
// Pending bubbles are interleaved into the chat message list as synthetic
// MessageWithUser-shaped objects. The sentinel `__pending` field lets renderers
// branch on pending vs. server-confirmed state, and `__transferId` on each
// attachment lets renderers subscribe to a single transfer for live progress
// (per-byte updates don't re-render the whole list).

/** A synthesized "MessageWithUser" representing a pending optimistic bubble. */
export interface PendingMessageView extends Omit<MessageWithUser, 'attachments'> {
  attachments: PendingAttachmentView[];
  /** Set when the bubble is for a DM; mirrors chatStore optimistic-temp convention. */
  dmChannelId?: string;
  __pending: PendingBubble;
}

/** A synthesized Attachment for a PendingMessageView. The optional `__transferId`
 *  field references the in-flight upload; consumers (Message.tsx) subscribe to
 *  the transfer individually so per-byte progress doesn't re-render the list. */
export interface PendingAttachmentView extends Attachment {
  __transferId?: string;
}

/** Type guard for PendingMessageView. */
export function isPendingMessage(
  m: MessageWithUser | PendingMessageView,
): m is PendingMessageView {
  const p = (m as PendingMessageView).__pending;
  return typeof p === 'object' && p !== null && 'clientId' in p;
}
