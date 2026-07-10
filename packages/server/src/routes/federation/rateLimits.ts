

// ─── In-memory rate limiter for the accept endpoint ──────────────────────────
export const acceptRateBuckets = new Map<string, number[]>();

export const ACCEPT_RATE_WINDOW_MS = 60_000;

export const ACCEPT_RATE_MAX = 10;


export function isAcceptRateLimited(ip: string): boolean {
  const now = Date.now();
  let timestamps = acceptRateBuckets.get(ip);
  if (!timestamps) {
    timestamps = [];
    acceptRateBuckets.set(ip, timestamps);
  }
  // Prune entries outside the window
  const cutoff = now - ACCEPT_RATE_WINDOW_MS;
  while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= ACCEPT_RATE_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}


// ─── In-memory rate limiter for the relay endpoint (per-peer) ────────────────
export const relayRateBuckets = new Map<string, number[]>();

export const RELAY_RATE_WINDOW_MS = 60_000;

export const RELAY_RATE_MAX = 90;


export function isRelayRateLimited(peerOrigin: string): boolean {
  const now = Date.now();
  let timestamps = relayRateBuckets.get(peerOrigin);
  if (!timestamps) {
    timestamps = [];
    relayRateBuckets.set(peerOrigin, timestamps);
  }
  const cutoff = now - RELAY_RATE_WINDOW_MS;
  while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= RELAY_RATE_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}


// ─── In-memory rate limiter for the user-lookup endpoint (per-peer) ──────────
export const lookupRateBuckets = new Map<string, number[]>();

export const LOOKUP_RATE_WINDOW_MS = 60_000;

export const LOOKUP_RATE_MAX = 60;


export function isLookupRateLimited(peerOrigin: string): boolean {
  const now = Date.now();
  let timestamps = lookupRateBuckets.get(peerOrigin);
  if (!timestamps) {
    timestamps = [];
    lookupRateBuckets.set(peerOrigin, timestamps);
  }
  const cutoff = now - LOOKUP_RATE_WINDOW_MS;
  while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= LOOKUP_RATE_MAX) return true;
  timestamps.push(now);
  return false;
}


// Test-only export — used by federation.userLookup.test.ts to reset between cases.
export function _resetLookupRateBuckets(): void {
  lookupRateBuckets.clear();
}


// ─── In-memory rate limiter for the ensure endpoint (per-user) ─────────────
export const ensureRateBuckets = new Map<string, number[]>();

export const ENSURE_RATE_WINDOW_MS = 15 * 60_000; // 15 minutes

export const ENSURE_RATE_MAX = 3;


export function isEnsureRateLimited(userId: string): boolean {
  const now = Date.now();
  let timestamps = ensureRateBuckets.get(userId);
  if (!timestamps) {
    timestamps = [];
    ensureRateBuckets.set(userId, timestamps);
  }
  const cutoff = now - ENSURE_RATE_WINDOW_MS;
  while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= ENSURE_RATE_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

// Clean up stale ensure rate limit buckets every 15 minutes
setInterval(() => {
  const cutoff = Date.now() - ENSURE_RATE_WINDOW_MS;
  for (const [userId, timestamps] of ensureRateBuckets) {
    while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) {
      ensureRateBuckets.delete(userId);
    }
  }
}, ENSURE_RATE_WINDOW_MS).unref();


// ─── In-memory nonce store for replay protection (per-peer) ──────────────────
// Maps peerOrigin → (nonce → insertion timestamp). Nonces are evicted after
// NONCE_MAX_AGE_MS (15 min) to match the HMAC timestamp window.
export const NONCE_MAX_AGE_MS = 15 * 60 * 1000;

export const nonceStore = new Map<string, Map<string, number>>();


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

// Periodically clean stale buckets to prevent unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - ACCEPT_RATE_WINDOW_MS;
  for (const [ip, timestamps] of acceptRateBuckets) {
    while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) {
      acceptRateBuckets.delete(ip);
    }
  }
  const relayCutoff = Date.now() - RELAY_RATE_WINDOW_MS;
  for (const [origin, timestamps] of relayRateBuckets) {
    while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < relayCutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) {
      relayRateBuckets.delete(origin);
    }
  }
  // Evict expired nonces
  const nonceCutoff = Date.now() - NONCE_MAX_AGE_MS;
  for (const [origin, nonces] of nonceStore) {
    for (const [nonce, ts] of nonces) {
      if (ts < nonceCutoff) nonces.delete(nonce);
    }
    if (nonces.size === 0) nonceStore.delete(origin);
  }
}, ACCEPT_RATE_WINDOW_MS).unref();
