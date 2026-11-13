import { createFixedWindowLimit } from './fixedWindowLimit.js';

/** Message creates allowed per account before the window ends. */
export const CHANNEL_MESSAGE_CREATE_RATE_LIMIT = { max: 5, windowMs: 5_000 } as const;

const limiter = createFixedWindowLimit(CHANNEL_MESSAGE_CREATE_RATE_LIMIT);

/** Count one channel message create for an account, across REST and WebSocket. */
export function consumeChannelMessageCreate(userId: string, now: number = Date.now()): boolean {
  return limiter.consume(userId, now);
}

/** Tests only: forget every account's window. */
export function _resetChannelMessageCreateLimit(): void {
  limiter.reset();
}
