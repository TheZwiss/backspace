import { createContext, useContext } from 'react';

/**
 * Scrolls the message list to a message by its id on the channel's origin,
 * loading the window around it when needed.
 */
export type JumpToMessage = (messageId: string) => void;

/**
 * Provided by `MessageList` so rows (the reply preview) reach the same
 * jump-to-message path that search results use. Null outside a list.
 */
export const MessageJumpContext = createContext<JumpToMessage | null>(null);

export function useMessageJump(): JumpToMessage | null {
  return useContext(MessageJumpContext);
}
