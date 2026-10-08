/**
 * The rate limit on creating DM messages: 5 per 5 seconds per client address.
 *
 * `POST /api/dm/:id/messages` applies it through `@fastify/rate-limit` (the
 * route's `config.rateLimit`, which replaces the global limit for that route).
 * The WebSocket `dm_message_create` event applies it through
 * `consumeWsDmMessageCreate` below, keyed on the socket's address
 * (`ws/socketAddress.ts`), and refuses with the same `rate_limited` code.
 *
 * The two paths count in separate buckets: the plugin keeps each route's
 * counter in a store of its own that nothing outside the plugin can reach.
 * The numbers live here once, so the two cannot drift apart.
 *
 * The WebSocket counter works as the plugin's in-memory store does: a fixed
 * window that starts at an address's first create and admits `max` creates
 * until it ends. `DISABLE_RATE_LIMITS=1` (or `true`) turns it off, as it
 * turns off the plugin (api.md, "Rate limiting").
 */
export const DM_MESSAGE_CREATE_RATE_LIMIT = { max: 5, windowMs: 5_000 } as const;

interface Window {
  count: number;
  startedAt: number;
}

const windows: Map<string, Window> = new Map();
let lastSweepAt = 0;

function rateLimitsDisabled(): boolean {
  const value = process.env.DISABLE_RATE_LIMITS;
  return value === '1' || value === 'true';
}

/** Drop the windows that have ended, at most once per window length. */
function sweep(now: number): void {
  if (now - lastSweepAt < DM_MESSAGE_CREATE_RATE_LIMIT.windowMs) return;
  lastSweepAt = now;
  for (const [address, window] of windows) {
    if (now - window.startedAt >= DM_MESSAGE_CREATE_RATE_LIMIT.windowMs) windows.delete(address);
  }
}

/**
 * Count one WebSocket DM message create from `address`. True when it is
 * within the limit; false when the address has used its creates for the
 * current window, in which case the create is refused.
 */
export function consumeWsDmMessageCreate(address: string, now: number = Date.now()): boolean {
  if (rateLimitsDisabled()) return true;
  sweep(now);
  const window = windows.get(address);
  if (!window || now - window.startedAt >= DM_MESSAGE_CREATE_RATE_LIMIT.windowMs) {
    windows.set(address, { count: 1, startedAt: now });
    return true;
  }
  window.count += 1;
  return window.count <= DM_MESSAGE_CREATE_RATE_LIMIT.max;
}

/** Tests only: forget every address's window. */
export function _resetWsDmMessageCreateLimit(): void {
  windows.clear();
  lastSweepAt = 0;
}
