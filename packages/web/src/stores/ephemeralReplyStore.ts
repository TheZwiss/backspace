import { create } from 'zustand';
import type { EphemeralReply } from '@backspace/shared';

/**
 * Bot answers only the signed-in person sees (`interaction_ephemeral`), per
 * chat: a space channel's id or a DM's id, the key `MessageList` is given.
 * Never stored by the server, so they live here until a reload, a sign-out or
 * a dismiss (bots.md, "Answering").
 */
interface EphemeralReplyState {
  byChat: Record<string, EphemeralReply[]>;
  add: (reply: EphemeralReply) => void;
  dismiss: (chatId: string, replyId: string) => void;
  reset: () => void;
}

/** The chat an answer belongs to. */
export function ephemeralChatId(reply: EphemeralReply): string {
  return reply.channelId ?? reply.dmChannelId ?? '';
}

const NONE: EphemeralReply[] = [];

export const useEphemeralReplyStore = create<EphemeralReplyState>((set) => ({
  byChat: {},
  add: (reply) => set((state) => {
    const chatId = ephemeralChatId(reply);
    const list = state.byChat[chatId] ?? NONE;
    if (!chatId || list.some((r) => r.id === reply.id)) return state;
    return { byChat: { ...state.byChat, [chatId]: [...list, reply].sort((a, b) => a.createdAt - b.createdAt) } };
  }),
  dismiss: (chatId, replyId) => set((state) => {
    const list = state.byChat[chatId];
    if (!list) return state;
    const rest = list.filter((r) => r.id !== replyId);
    const byChat = { ...state.byChat };
    if (rest.length > 0) byChat[chatId] = rest;
    else delete byChat[chatId];
    return { byChat };
  }),
  reset: () => set({ byChat: {} }),
}));

/** The answers of one chat, oldest first; a stable empty list when there are none. */
export function useEphemeralReplies(chatId: string): EphemeralReply[] {
  return useEphemeralReplyStore((state) => state.byChat[chatId] ?? NONE);
}
