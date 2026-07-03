import crypto from 'node:crypto';
import type { SpawnedInstance } from './twoInstanceHarness.js';

export interface TestUser {
  id: string;
  username: string;
  password: string;
  token: string;
  origin: string;        // origin where this token authenticates
  homeUserId?: string;   // present for federated users — the id on the user's home instance
  homeInstance?: string; // present for federated users
}

const nano = () => crypto.randomBytes(4).toString('hex');

/**
 * Register a native local user on `instance` via POST /api/auth/register.
 * Returns the user record + JWT.
 *
 * Endpoint contract (verified against packages/server/src/routes/auth.ts):
 *  - Request body: { username, password, displayName?, avatarColor?, homeInstance?, homeUserId? }
 *  - Response 201: { token, user: { id, ... } }
 */
export async function registerLocal(instance: SpawnedInstance, baseName = 't'): Promise<TestUser> {
  // Username validator (auth.ts): /^[a-z0-9_]+$/, length 3-32. Lowercase the
  // baseName and use underscore separator so callers can pass readable names
  // like "probe-local" without tripping the validator.
  const safeBase = baseName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const username = `${safeBase}_${nano()}`;
  const password = `pw_${crypto.randomBytes(8).toString('hex')}`;
  const res = await fetch(`${instance.origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, displayName: username }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`registerLocal failed (${instance.origin}): ${res.status} ${txt}`);
  }
  const data = await res.json() as { user: { id: string }; token: string };
  return {
    id: data.user.id,
    username,
    password,
    token: data.token,
    origin: instance.origin,
  };
}

/**
 * Create a federated account: register `home` first (native), then create the
 * `username@homeDomain` mirror on `remote` via POST /api/auth/register with
 * homeInstance + homeUserId — the production federated-account-creation path
 * documented in client-federation.md §1. Returns BOTH user records.
 *
 * Also seeds the home's user_federation_registry via PUT
 * /api/users/@me/federation-registry so the home's federation-identity
 * delete endpoint sees this remote in the user's registry.
 *
 * Registry PUT contract (verified against packages/server/src/routes/users.ts):
 *  - Body: { registry: Array<{...}>, updatedAt: number }
 *    NOTE: the route's array key is `registry`, NOT `entries` as the original
 *    plan template suggested. The deviation has been applied here.
 *  - Per-entry required: { origin: string, status: 'connected'|'disconnected'|'unreachable'|'auth_expired', addedAt: number }
 *  - Per-entry optional: { label, username, remoteUserId, lastConnectedAt, disconnectedAt, errorMessage }
 *  - LWW guard: updatedAt must be > stored federationRegistryUpdatedAt (else 409).
 */
export async function createFederatedUser(
  home: SpawnedInstance,
  remote: SpawnedInstance,
  baseName = 't',
): Promise<{ homeUser: TestUser; remoteUser: TestUser }> {
  const homeUser = await registerLocal(home, baseName);
  const federatedUsername = `${homeUser.username}@${home.domain}`;

  const res = await fetch(`${remote.origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: federatedUsername,
      password: homeUser.password,
      displayName: homeUser.username,
      homeInstance: home.domain,
      homeUserId: homeUser.id,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`createFederatedUser remote register failed: ${res.status} ${txt}`);
  }
  const data = await res.json() as { user: { id: string }; token: string };

  const remoteUser: TestUser = {
    id: data.user.id,
    username: federatedUsername,
    password: homeUser.password,
    token: data.token,
    origin: remote.origin,
    homeUserId: homeUser.id,
    homeInstance: home.domain,
  };

  // Seed the home user's federation registry. Body shape matches the route's
  // declared Body<{ registry, updatedAt }> — see users.ts L591-L594.
  const registryUpdatedAt = Date.now();
  const registryRes = await fetch(`${home.origin}/api/users/@me/federation-registry`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${homeUser.token}`,
    },
    body: JSON.stringify({
      updatedAt: registryUpdatedAt,
      registry: [
        {
          origin: remote.origin,
          label: remote.domain,
          username: federatedUsername,
          remoteUserId: remoteUser.id,
          status: 'connected',
          addedAt: registryUpdatedAt,
          lastConnectedAt: registryUpdatedAt,
        },
      ],
    }),
  });
  if (!registryRes.ok) {
    const txt = await registryRes.text();
    throw new Error(`registry sync failed: ${registryRes.status} ${txt}`);
  }

  return { homeUser, remoteUser };
}
