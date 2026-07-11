// ─── In-memory sliding-window rate limiters (federation S2S endpoints) ───────
//
// Each limiter keeps a per-key ring of request timestamps inside a fixed window.
// `limited(key)` prunes that key's expired entries, then returns true (without
// recording a hit) once the key is at capacity. `sweep()` prunes every key and
// drops emptied buckets to bound memory; it runs on a timer, not per request.

interface SlidingWindowLimiter {
  /** True if `key` is already at capacity for the current window; otherwise records the hit and returns false. */
  limited(key: string): boolean;
  /** Prune expired timestamps across all keys and drop now-empty buckets. */
  sweep(): void;
  /** Underlying buckets — exposed only so tests can reset state. */
  readonly buckets: Map<string, number[]>;
}

function createLimiter(windowMs: number, max: number): SlidingWindowLimiter {
  const buckets = new Map<string, number[]>();
  const prune = (timestamps: number[], cutoff: number): void => {
    while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
      timestamps.shift();
    }
  };
  return {
    buckets,
    limited(key: string): boolean {
      const now = Date.now();
      let timestamps = buckets.get(key);
      if (!timestamps) {
        timestamps = [];
        buckets.set(key, timestamps);
      }
      prune(timestamps, now - windowMs);
      if (timestamps.length >= max) return true;
      timestamps.push(now);
      return false;
    },
    sweep(): void {
      const cutoff = Date.now() - windowMs;
      for (const [key, timestamps] of buckets) {
        prune(timestamps, cutoff);
        if (timestamps.length === 0) buckets.delete(key);
      }
    },
  };
}

const RATE_WINDOW_MS = 60_000;
const ENSURE_WINDOW_MS = 15 * 60_000;

// accept: per source IP · relay & user-lookup: per peer origin · ensure: per user
const acceptLimiter = createLimiter(RATE_WINDOW_MS, 10);
const relayLimiter = createLimiter(RATE_WINDOW_MS, 90);
const lookupLimiter = createLimiter(RATE_WINDOW_MS, 60);
const ensureLimiter = createLimiter(ENSURE_WINDOW_MS, 3);

export const isAcceptRateLimited = (ip: string): boolean => acceptLimiter.limited(ip);
export const isRelayRateLimited = (peerOrigin: string): boolean => relayLimiter.limited(peerOrigin);
export const isLookupRateLimited = (peerOrigin: string): boolean => lookupLimiter.limited(peerOrigin);
export const isEnsureRateLimited = (userId: string): boolean => ensureLimiter.limited(userId);

// Test-only export — used by federation.userLookup.test.ts to reset between cases.
export function _resetLookupRateBuckets(): void {
  lookupLimiter.buckets.clear();
}

// ─── Nonce store for replay protection (per-peer) ────────────────────────────
// Maps peerOrigin → (nonce → insertion timestamp). Nonces are evicted after
// NONCE_MAX_AGE_MS (15 min) to match the HMAC timestamp window.
const NONCE_MAX_AGE_MS = 15 * 60 * 1000;
const nonceStore = new Map<string, Map<string, number>>();

/** Returns true if the nonce is a duplicate (already seen for this peer). */
export function isNonceDuplicate(peerOrigin: string, nonce: string): boolean {
  let peerNonces = nonceStore.get(peerOrigin);
  if (!peerNonces) {
    peerNonces = new Map();
    nonceStore.set(peerOrigin, peerNonces);
  }
  if (peerNonces.has(nonce)) return true;
  peerNonces.set(nonce, Date.now());
  return false;
}

// ─── Periodic cleanup to bound memory ────────────────────────────────────────
// Ensure buckets sweep on their own (long) window. Accept + relay buckets and
// nonce eviction share the short window. Lookup buckets are pruned per-call only
// (never swept here) — preserving the original behavior.
setInterval(() => ensureLimiter.sweep(), ENSURE_WINDOW_MS).unref();

setInterval(() => {
  acceptLimiter.sweep();
  relayLimiter.sweep();
  const nonceCutoff = Date.now() - NONCE_MAX_AGE_MS;
  for (const [origin, nonces] of nonceStore) {
    for (const [nonce, ts] of nonces) {
      if (ts < nonceCutoff) nonces.delete(nonce);
    }
    if (nonces.size === 0) nonceStore.delete(origin);
  }
}, RATE_WINDOW_MS).unref();
