import {
  bootHomePlusRemotes,
  spawnInstance,
  type SpawnedInstance,
  type TwoInstanceHarness,
} from './twoInstanceHarness.js';
import { registerLocal } from './testUsers.js';
import { openInspector } from './dbInspect.js';
import { buildHeadersForOrigin } from './hmacSign.js';

/**
 * Real-handshake two-instance harness helpers.
 *
 * Unlike `seedPeer.ts` (which SEEDS matching peer rows via a test route and so
 * never exercises the real `/peer/initiate`→`/peer/accept` handshake — where the
 * bugs live), these helpers drive the REAL handshake between two localhost
 * instances.
 *
 * The single enabling trick: each instance is spawned with
 * `PUBLIC_ORIGIN=http://127.0.0.1:<its-port>` (see `bootHomePlusRemotes`'s
 * `publicOriginAsTransport` flag). That makes `getOurOrigin()` return the
 * TRANSPORT url instead of the identity `https://<DOMAIN>`, so a single real
 * handshake creates exactly one reachable peer row per direction, keyed by the
 * transport origin. Outbound fetch, inbound HMAC lookup (`X-Federation-Origin`),
 * and the `/api/federation/epoch` peer lookup all then agree on that one origin.
 *
 * Cleanup of RESPAWNED (reset) processes: `simulateReset` registers each fresh
 * process against its harness in a module-level map, and the `cleanup()` returned
 * by `bootTwoInstancesForHandshake` drains that map (killing any respawned procs)
 * before delegating to the base harness cleanup. Tests therefore only need to
 * call `harness.cleanup()` in `afterAll` — respawned procs are handled for them.
 */

/**
 * Shape of a peer as returned by `GET /api/federation/peers` (`sanitizePeer`)
 * and `POST /api/federation/peer/initiate`. Kept permissive (index signature)
 * so callers can read fields not enumerated here without a cast.
 */
export interface FederationPeerLike {
  id: string;
  origin: string;
  instanceName: string | null;
  status: string;
  needsAttentionReason: 'auth_failures' | 'peer_reset_detected' | 'repeer_incomplete' | null;
  [key: string]: unknown;
}

// Tracks processes respawned by `simulateReset` so `harness.cleanup()` can kill
// them (they are NOT in the base harness's [home, ...remotes] list).
const respawnedByHarness = new WeakMap<TwoInstanceHarness, SpawnedInstance[]>();

/**
 * Boot 1 home + 1 remote, each with `PUBLIC_ORIGIN` = its own transport origin.
 * Same shape as `bootTwoInstances`, but the returned `cleanup()` also kills any
 * processes created by `simulateReset` against this harness.
 */
export async function bootTwoInstancesForHandshake(): Promise<TwoInstanceHarness> {
  const m = await bootHomePlusRemotes(1, { publicOriginAsTransport: true });
  const harness: TwoInstanceHarness = {
    home: m.home,
    remote: m.remotes[0]!,
    remotes: m.remotes,
    runDir: m.runDir,
    cleanup: async () => {},
  };
  harness.cleanup = async () => {
    const extra = respawnedByHarness.get(harness) ?? [];
    for (const inst of extra) {
      if (!inst.proc.killed) {
        inst.proc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 300));
        if (!inst.proc.killed) inst.proc.kill('SIGKILL');
      }
    }
    respawnedByHarness.delete(harness);
    await m.cleanup();
  };
  return harness;
}

/**
 * Register the FIRST user on a fresh instance, which auto-becomes admin
 * (verified auth.ts:203-223: `isFirstUser = userCount === 0 && !homeInstance`).
 * Returns just the admin JWT.
 */
export async function registerAdmin(inst: SpawnedInstance): Promise<{ token: string }> {
  const u = await registerLocal(inst, 'admin');
  return { token: u.token };
}

/**
 * Drive the real handshake: `POST /api/federation/peer/initiate` on `fromInst`
 * targeting `toInst.origin`. Returns the HTTP status and parsed body (tolerating
 * a non-JSON body → `{}`).
 */
export async function initiatePeering(
  fromInst: SpawnedInstance,
  adminToken: string,
  toInst: SpawnedInstance,
): Promise<{ status: number; body: { peer?: FederationPeerLike; verified?: boolean; code?: string; error?: string } }> {
  const res = await fetch(`${fromInst.origin}/api/federation/peer/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ remoteOrigin: toInst.origin }),
  });
  let body: { peer?: FederationPeerLike; verified?: boolean; code?: string; error?: string } = {};
  try {
    body = await res.json() as typeof body;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

/**
 * `POST /api/federation/peers/:id/reset` — reset a peer that needs attention.
 * Admin-authenticated. Returns just the HTTP status.
 */
export async function resetPeer(
  inst: SpawnedInstance,
  adminToken: string,
  peerId: string,
): Promise<{ status: number }> {
  const res = await fetch(`${inst.origin}/api/federation/peers/${peerId}/reset`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${adminToken}` },
  });
  return { status: res.status };
}

/**
 * `GET /api/federation/peers` — find the peer row keyed by `origin`. Peers are
 * keyed by transport origin under `PUBLIC_ORIGIN`, so pass e.g. `toInst.origin`.
 * Returns null if no matching peer exists.
 */
export async function getPeer(
  inst: SpawnedInstance,
  adminToken: string,
  origin: string,
): Promise<FederationPeerLike | null> {
  const res = await fetch(`${inst.origin}/api/federation/peers`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as { peers?: FederationPeerLike[] };
  const peers = data.peers ?? [];
  return peers.find(p => p.origin === origin) ?? null;
}

export async function s2sHealthy(fromInst: SpawnedInstance, toInst: SpawnedInstance): Promise<boolean> {
  const insp = openInspector(fromInst);
  try {
    const peer = insp.federationPeer(toInst.origin);
    if (!peer) return false;
    const body = JSON.stringify({});
    // fromInst's getOurOrigin() === fromInst.origin (PUBLIC_ORIGIN), which is
    // the origin toInst stored for the peer row — so the /epoch lookup matches.
    const headers = buildHeadersForOrigin(body, peer.hmacSecret, fromInst.origin);
    const res = await fetch(`${toInst.origin}/api/federation/epoch`, { method: 'POST', headers, body });
    if (!res.ok) return false;
    // Response is HMAC-signed with the same secret; a healthy link returns a
    // valid signed {instanceId}. A 200 with parseable instanceId is sufficient
    // proof the shared secret authenticates in this direction.
    const text = await res.text();
    return typeof (JSON.parse(text) as { instanceId?: string }).instanceId === 'string';
  } catch {
    return false;
  } finally {
    insp.close();
  }
}

/**
 * Spawn a fresh instance reusing the same port + domain + secrets as a killed
 * instance, with `PUBLIC_ORIGIN` pinned to that port so peers keep addressing it
 * at the same origin. Thin wrapper over `spawnInstance` (DRY — no duplicated
 * spawn logic).
 */
async function spawnInstanceForReset(opts: {
  domain: string;
  port: number;
  dbPath: string;
  storagePath: string;
  jwtSecret: string;
  logPath: string;
}): Promise<SpawnedInstance> {
  return spawnInstance({ ...opts, publicOriginAsTransport: true });
}

export async function simulateReset(inst: SpawnedInstance, harness: TwoInstanceHarness): Promise<SpawnedInstance> {
  inst.proc.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 600));
  if (!inst.proc.killed) inst.proc.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 200));
  // Fresh DB on the SAME port + domain → "factory reset on the same domain":
  // new instance_id, no peer rows, but peers still address it at the same origin.
  const freshDbPath = `${harness.runDir}/${inst.domain}-reset-${Date.now()}.db`;
  const fresh = await spawnInstanceForReset({
    domain: inst.domain, port: inst.port, dbPath: freshDbPath,
    storagePath: inst.storagePath, jwtSecret: inst.jwtSecret,
    logPath: `${harness.runDir}/${inst.domain}-reset.log`,
  });
  // Register for cleanup: the base harness's [home, ...remotes] list holds only
  // the ORIGINAL (now-dead) handle, so `harness.cleanup()` would otherwise leak
  // this respawned process. bootTwoInstancesForHandshake drains this list.
  const list = respawnedByHarness.get(harness) ?? [];
  list.push(fresh);
  respawnedByHarness.set(harness, list);
  return fresh;
}
