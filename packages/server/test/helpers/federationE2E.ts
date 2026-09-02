import Database from 'better-sqlite3';
import type { FederationRelayEvent, FederationRelayResponse } from '@backspace/shared';
import {
  bootHomePlusRemotes,
  type BootOptions,
  type SpawnedInstance,
} from './twoInstanceHarness.js';
import { registerAdmin, initiatePeering } from './realHandshake.js';
import { openInspector } from './dbInspect.js';
import { buildHeadersForOrigin } from './hmacSign.js';

/**
 * Shared rig for the two-instance federation e2e suites.
 *
 * ── Why two profiles ─────────────────────────────────────────────────────────
 * Production collapses three different origins into one string: the instance's
 * federated IDENTITY (`extractDomain(homeInstance)`), its TRANSPORT url (what
 * `fetch` dials), and the `federation_peers.origin` key. On a real deployment
 * all three are `https://${DOMAIN}`. On loopback they cannot all be the same,
 * because every instance shares the host `127.0.0.1` and differs only by port —
 * and `extractDomain` (the attribution comparison) strips the port.
 *
 * So a single harness profile cannot serve every fix. There are two:
 *
 *   IDENTITY profile — `bootIdentityPeered()`
 *     `PUBLIC_ORIGIN` unset, so `getOurOrigin()` is `https://<DOMAIN>` and each
 *     instance has a DISTINCT identity domain (`home.test.local`,
 *     `remote0.test.local`, …). The real `/peer/initiate` handshake leaves the
 *     initiator with a transport-keyed peer row (so it can dial) and the
 *     responder with an identity-keyed one (so it can authenticate the
 *     signature) — see `dumpPeerRows` output in the suites. Inbound relay is
 *     therefore fully real, and attribution can actually tell three instances
 *     apart. Used by the attribution and stub-claiming suites.
 *
 *   TRANSPORT profile — `bootTransportPeered()`
 *     `PUBLIC_ORIGIN=http://127.0.0.1:<port>` on every instance, so identity,
 *     transport and peer key are one string again, exactly as in production.
 *     Outbound relay routing (`getGroupDmTargetOrigins`, `sendCallRelay`)
 *     resolves to a live peer and events are really delivered. The cost is that
 *     `extractDomain` collapses every instance to `127.0.0.1`, so inbound
 *     attribution cannot discriminate — which is fine for suites that assert
 *     OUTBOUND addressing. Used by the relay-scoping and call-addressing suites.
 *
 * Both profiles peer through the real HMAC handshake
 * (`POST /api/federation/peer/initiate` → `/peer/accept` → signed `/epoch`
 * verification). No suite inserts a `federation_peers` row.
 */

export interface PeeredHarness {
  /** The instance that initiates every handshake. */
  home: SpawnedInstance;
  /** The peers `home` is peered with, in the order they were requested. */
  remotes: SpawnedInstance[];
  /** Admin JWT for `home` (first registered user auto-becomes admin). */
  homeAdminToken: string;
  /** Admin JWTs for each remote, index-aligned with `remotes`. */
  remoteAdminTokens: string[];
  cleanup: () => Promise<void>;
}

/** The origin an instance signs its outbound S2S requests with. */
export function identityOrigin(inst: SpawnedInstance): string {
  return `https://${inst.domain}`;
}

export interface PeeringOptions {
  /**
   * Origin to dial for each remote when initiating. Defaults to the remote's own
   * origin; the call-addressing suite passes a `RelayTap` origin so the S2S
   * conversation is readable in transit.
   */
  dialOrigins?: string[];
  /**
   * Runs after every instance is up but BEFORE any handshake. A tap has to be
   * wired to its instance here: the tap's origin is what the handshake dials, but
   * the instance's own origin is only known once it has bound its port.
   */
  beforePeering?: (home: SpawnedInstance, remotes: SpawnedInstance[]) => void | Promise<void>;
}

async function bootAndPeer(
  remoteCount: number,
  options: BootOptions,
  peering: PeeringOptions = {},
): Promise<PeeredHarness> {
  const { dialOrigins, beforePeering } = peering;
  const m = await bootHomePlusRemotes(remoteCount, options);
  const harness: PeeredHarness = {
    home: m.home,
    remotes: m.remotes,
    homeAdminToken: '',
    remoteAdminTokens: [],
    cleanup: m.cleanup,
  };
  try {
    if (beforePeering) await beforePeering(m.home, m.remotes);
    harness.homeAdminToken = (await registerAdmin(m.home)).token;
    for (const r of m.remotes) {
      harness.remoteAdminTokens.push((await registerAdmin(r)).token);
    }
    for (let i = 0; i < m.remotes.length; i++) {
      const remote = m.remotes[i]!;
      const dial = dialOrigins?.[i] ?? remote.origin;
      const res = await initiatePeering(m.home, harness.homeAdminToken, { ...remote, origin: dial });
      if (res.status !== 200 || res.body.verified !== true) {
        throw new Error(
          `real handshake home -> ${dial} failed: ${res.status} ${JSON.stringify(res.body)}`,
        );
      }
    }
  } catch (err) {
    // Never leak spawned processes or temp dirs when setup throws.
    await m.cleanup();
    throw err;
  }
  return harness;
}

/**
 * IDENTITY profile: distinct federated identity domains, real inbound relay.
 * See the header comment for why this is not the same rig as the transport one.
 */
export async function bootIdentityPeered(remoteCount = 1): Promise<PeeredHarness> {
  return bootAndPeer(remoteCount, { publicOriginAsTransport: false });
}

/**
 * TRANSPORT profile: identity == transport == peer key, real OUTBOUND relay
 * delivery. Federation workers run (the outbox loop is what actually POSTs), and
 * LiveKit is given synthetic credentials so call tokens can be minted locally.
 */
export async function bootTransportPeered(
  remoteCount = 1,
  peering: PeeringOptions = {},
): Promise<PeeredHarness> {
  return bootAndPeer(
    remoteCount,
    {
      publicOriginAsTransport: true,
      enableFederationWorkers: true,
      enableLiveKit: true,
    },
    peering,
  );
}

/**
 * The HMAC secret `receiver` holds for the peer that signs as `signerOrigin`.
 * Read from the receiver's live DB, so it is whatever the REAL handshake
 * negotiated — nothing is seeded.
 */
export function peerSecretOn(receiver: SpawnedInstance, signerOrigin: string): string {
  const insp = openInspector(receiver);
  try {
    const peer = insp.federationPeer(signerOrigin);
    if (!peer) {
      throw new Error(`${receiver.domain} holds no peer row for ${signerOrigin} — handshake did not complete`);
    }
    if (peer.status !== 'active') {
      throw new Error(`${receiver.domain}'s peer row for ${signerOrigin} is ${peer.status}, not active`);
    }
    return peer.hmacSecret;
  } finally {
    insp.close();
  }
}

export interface RelayPostResult {
  status: number;
  /** Parsed relay response; null when the endpoint answered with an error body. */
  body: FederationRelayResponse | null;
  /** Raw text, for asserting on error payloads. */
  raw: string;
}

/**
 * POST a genuinely HMAC-signed relay batch to `receiver`'s real
 * `/api/federation/relay` endpoint over real HTTP.
 *
 * `signerOrigin` is both the `X-Federation-Origin` header (what the receiver
 * looks the peer up by) and, by default, the batch's `sourceInstance`. Passing a
 * different `sourceInstance` is how the suites exercise the source-to-peer
 * binding: the signature is still valid, but the claimed source is not the peer
 * that proved it.
 */
export async function postSignedRelay(
  receiver: SpawnedInstance,
  signerOrigin: string,
  secret: string,
  events: FederationRelayEvent[],
  opts: { sourceInstance?: string } = {},
): Promise<RelayPostResult> {
  const payload = JSON.stringify({
    version: 1,
    sourceInstance: opts.sourceInstance ?? signerOrigin,
    events,
  });
  const headers = buildHeadersForOrigin(payload, secret, signerOrigin);
  const res = await fetch(`${receiver.origin}/api/federation/relay`, {
    method: 'POST',
    headers,
    body: payload,
  });
  const raw = await res.text();
  let body: FederationRelayResponse | null = null;
  try {
    const parsed = JSON.parse(raw) as Partial<FederationRelayResponse>;
    if (Array.isArray(parsed.accepted) && Array.isArray(parsed.rejected)) {
      body = parsed as FederationRelayResponse;
    }
  } catch {
    body = null;
  }
  return { status: res.status, body, raw };
}

/** The `reason` the batch recorded for `messageId`, or null when not rejected. */
export function rejectionReason(result: RelayPostResult, messageId: string): string | null {
  return result.body?.rejected.find(r => r.messageId === messageId)?.reason ?? null;
}

/**
 * Run `fn` against a WRITABLE handle on a live instance's DB.
 *
 * Used only for fixture setup that has no HTTP surface on loopback — pointing a
 * replicated user's `home_instance` at the peer's transport origin, and seeding
 * `friends` rows so the real group-DM endpoint's friendship gate passes. Never
 * used to produce the behaviour under test. SQLite WAL permits a second writer
 * while the server process holds the DB.
 */
export function withWritableDb(inst: SpawnedInstance, fn: (db: Database.Database) => void): void {
  const db = new Database(inst.dbPath);
  db.pragma('journal_mode = WAL');
  try {
    fn(db);
  } finally {
    db.close();
  }
}

/** Run a read-only query against a live instance's DB. */
export function readDb<T>(inst: SpawnedInstance, fn: (db: Database.Database) => T): T {
  const db = new Database(inst.dbPath, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Every `dm_messages.content` on an instance. */
export function dmMessageContents(inst: SpawnedInstance): string[] {
  return readDb(inst, db =>
    (db.prepare('SELECT content FROM dm_messages').all() as { content: string | null }[])
      .map(r => r.content ?? ''),
  );
}

/** Users whose `home_instance` matches `domain` (i.e. replicated stubs from it). */
export function stubsFrom(inst: SpawnedInstance, domain: string): { id: string; username: string }[] {
  return readDb(inst, db =>
    db
      .prepare('SELECT id, username FROM users WHERE home_instance = ?')
      .all(domain) as { id: string; username: string }[],
  );
}

/**
 * Poll `check` until it returns true or `timeoutMs` elapses. Returns whether it
 * ever became true. Federation delivery is worker-driven (1s outbox tick), so
 * positive assertions poll rather than sleeping a fixed amount.
 */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/**
 * Settle time for a NEGATIVE assertion ("this relay never went out").
 *
 * Deliberately several outbox ticks long: a fix that merely DELAYED the relay
 * rather than suppressing it must have had ample opportunity to deliver before
 * the assertion runs, or the negative would pass for the wrong reason. Every
 * suite that waits this long also has a positive control that delivers well
 * inside the same window.
 */
export const RELAY_SETTLE_MS = 5_000;

export async function settleRelays(): Promise<void> {
  await new Promise(r => setTimeout(r, RELAY_SETTLE_MS));
}

// ─── Small REST helpers shared by more than one suite ────────────────────────

export async function createDm(
  inst: SpawnedInstance,
  token: string,
  targetUserId: string,
): Promise<string> {
  const res = await fetch(`${inst.origin}/api/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId: targetUserId }),
  });
  if (!res.ok) throw new Error(`createDm failed: ${res.status} ${await res.text()}`);
  return (await res.json() as { id: string }).id;
}

export interface SentDmMessage {
  status: number;
  id: string | null;
  error: string | null;
}

export async function sendDmMessage(
  inst: SpawnedInstance,
  token: string,
  dmChannelId: string,
  body: { content?: string; replyToId?: string },
): Promise<SentDmMessage> {
  const res = await fetch(`${inst.origin}/api/dm/${dmChannelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let id: string | null = null;
  let error: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { id?: string; error?: string };
    id = parsed.id ?? null;
    error = parsed.error ?? null;
  } catch {
    error = raw;
  }
  return { status: res.status, id, error };
}

export interface DmMessageView {
  id: string;
  content: string | null;
  replyTo: { id: string } | null;
}

export async function listDmMessages(
  inst: SpawnedInstance,
  token: string,
  dmChannelId: string,
): Promise<DmMessageView[]> {
  const res = await fetch(`${inst.origin}/api/dm/${dmChannelId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`listDmMessages failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { messages?: DmMessageView[] } | DmMessageView[];
  return Array.isArray(data) ? data : (data.messages ?? []);
}
