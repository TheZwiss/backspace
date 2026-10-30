import { createFixedWindowLimit } from './fixedWindowLimit.js';

/**
 * DM message creates allowed per account before the window ends.
 *
 * REST and WebSocket creates share this bucket, so opening another client or
 * switching transport cannot multiply the budget. The global HTTP limiter
 * remains the separate per-address flood ceiling.
 */
export const DM_MESSAGE_CREATE_RATE_LIMIT = { max: 5, windowMs: 5_000 } as const;

const limiter = createFixedWindowLimit(DM_MESSAGE_CREATE_RATE_LIMIT);

/**
 * Count one DM message create for an account. True when it is within the
 * limit; false when the account has used its creates for the current window.
 */
export function consumeDmMessageCreate(userId: string, now: number = Date.now()): boolean {
  return limiter.consume(userId, now);
}

/** Tests only: forget every account's window. */
export function _resetDmMessageCreateLimit(): void {
  limiter.reset();
}
