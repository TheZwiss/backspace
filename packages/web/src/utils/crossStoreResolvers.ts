// Cross-store resolvers for federation identity and API client routing.
//
// This module exists SOLELY to break a temporal-dead-zone (TDZ) cycle between
// spaceStore and instanceStore. instanceStore runs top-level `setXResolver`
// calls at module load; the backing `let` bindings used to live in spaceStore.
// When the import graph is entered from instanceStore (e.g. via a component
// like JoinSpaceModal that imports `useInstanceStore` directly) — or any chain
// that resolves in an order where spaceStore is mid-load when instanceStore's
// top-level code runs — the `let _getApiForOrigin = null` declaration has not
// been evaluated yet, so the setter crashes with
// `Cannot access '_getApiForOrigin' before initialization`.
//
// The fix: hold the resolvers, their setters, and the local user-ID cache
// in this neutral module. It imports nothing from any store, so no back-edge
// exists and module load order between spaceStore / instanceStore / anything
// else cannot cause TDZ. spaceStore re-exports the public surface for
// backward compatibility with existing import sites.
//
// IMPORTANT: do not add imports from any `./stores/*` module here. Doing so
// re-creates the exact cycle this module was carved out to break.

import { api, BackspaceApiClient } from '../api/client';

// ─── API client resolution ────────────────────────────────────────────────────
// Registered by instanceStore on import; maps an origin to the instance-
// specific API client. `'' | null | undefined` origin always returns the home
// `api` client.

let _getApiForOrigin: ((origin: string) => BackspaceApiClient) | null = null;

export function setApiForOriginResolver(
  resolver: (origin: string) => BackspaceApiClient
): void {
  _getApiForOrigin = resolver;
}

export function getApiForOrigin(origin: string): BackspaceApiClient {
  if (!origin || !_getApiForOrigin) return api;
  return _getApiForOrigin(origin);
}

// ─── Hostname → origin resolution (federation) ────────────────────────────────
// Registered by instanceStore on import; maps a federated user's `homeInstance`
// hostname (e.g. "remote.example.com") to a full origin URL
// (e.g. "https://remote.example.com") by looking up connected instances.

let _resolveOriginFromHostname: ((hostname: string) => string) | null = null;

export function setOriginFromHostnameResolver(
  resolver: (hostname: string) => string
): void {
  _resolveOriginFromHostname = resolver;
}

/**
 * Pure hostname→origin lookup. Returns '' if the resolver is not yet
 * registered or the hostname is unknown. Callers that need to combine this
 * with `window.location.host` or `authStore` state should layer on top
 * (see `resolveUserOrigin` / `getLayoutHomeOrigin` in spaceStore).
 */
export function resolveOriginFromHostname(hostname: string): string {
  return _resolveOriginFromHostname?.(hostname) ?? '';
}

// ─── User ID resolution (federation) ──────────────────────────────────────────
// Registered by instanceStore on import; maps an origin to the local user's
// ID on that instance. Used as a fallback for `getMyUserIdForOrigin` when the
// direct WS-populated cache below has not yet been filled.

let _getUserIdForOrigin: ((origin: string) => string | undefined) | null = null;

export function setUserIdForOriginResolver(
  resolver: (origin: string) => string | undefined
): void {
  _getUserIdForOrigin = resolver;
}

export function resolveUserIdFromInstances(origin: string): string | undefined {
  return _getUserIdForOrigin?.(origin);
}

// ─── Direct user-ID cache (populated from WS ready events) ────────────────────
// Bypasses the instanceStore resolver for reliable federation support even
// while `instanceStore.instances[].user` is still a placeholder mid-connection.

const _myUserIdByOrigin = new Map<string, string>();

export function setMyUserIdForOrigin(origin: string, userId: string): void {
  _myUserIdByOrigin.set(origin, userId);
}

export function getCachedUserIdForOrigin(origin: string): string | undefined {
  return _myUserIdByOrigin.get(origin);
}

/** Clears the WS-populated user-ID cache. Called by spaceStore.reset() on logout. */
export function clearMyUserIdCache(): void {
  _myUserIdByOrigin.clear();
}
