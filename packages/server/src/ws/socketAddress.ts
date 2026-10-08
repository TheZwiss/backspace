import type { WebSocket } from 'ws';

/**
 * The client address of each WebSocket, taken from the upgrade request when
 * the socket connects to `/ws`. It is `request.ip`, so it follows
 * `config.trustedProxyHops` exactly as the HTTP rate limiter's key does
 * (api.md, "Rate limiting"). Per-address limits on WebSocket events read it
 * from here, so an address has the same key on both paths.
 *
 * Held in a WeakMap, so an entry goes away with its socket.
 */
const addresses: WeakMap<WebSocket, string> = new WeakMap();

export function recordSocketAddress(ws: WebSocket, address: string): void {
  addresses.set(ws, address);
}

/**
 * The address recorded for `ws`. Every socket accepted on `/ws` has one; a
 * socket that did not come through `/ws` (a test's stand-in) has none.
 */
export function socketAddressOf(ws: WebSocket): string | undefined {
  return addresses.get(ws);
}
