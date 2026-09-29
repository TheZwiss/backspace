import Database from 'better-sqlite3';
import type { FederationRelayEvent, FederationRelayResponse } from '@backspace/shared';
import {
  bootHomePlusRemotes,
  readInstanceLog,
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
 *     The home's only row for a remote is transport-keyed, so the remote's
 *     signed requests to the home (relay, `/sync`) find no row and are refused.
 *     A suite that needs signed traffic INTO the home passes `{ reverse: true }`:
 *     the remote then runs the same real handshake back to the home, which
 *     leaves the home an ACTIVE row keyed by the remote's identity origin (and
 *     the remote a transport-keyed row to dial the home by).
 *     Because the initiator's row is keyed by the transport origin, a remote
 *     identity domain (`remote0.test.local`) maps to no peer there
 *     (`resolveOriginFromHostname`), so the initiator never asks the identity's
 *     home: first contact falls back to the `<homeUserId>@<domain>` name. In
 *     production the admin dials `https://DOMAIN` and the row is keyed by it.
 *
 *   TRANSPORT profile — `bootTransportPeered()`
 *     `PUBLIC_ORIGIN=http://127.0.0.1:<port>` on every instance, so identity,
 *     transport and peer key are one string again, exactly as in production.
 *     Outbound relay routing (`getGroupDmTargetOrigins`, `sendCallRelay`)
 *     resolves to a live peer and events are really delivered. The cost is that
 *     `extractDomain` collapses every instance to `127.0.0.1`, so inbound
 *     attribution cannot discriminate — which is fine for suites that assert
 *     OUTBOUND addressing. Used by the relay-scoping and call-addressing suites.
 *     An identity names a peer here by its bare host, as a stored replica does,
 *     and that host maps to the peer's (ported) row, so the signed lookups an
 *     instance makes of an identity's home are real: the first-contact suite
 *     uses this profile with one remote.
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
  /**
   * After each home -> remote handshake, also run the remote -> home one. Only
   * the IDENTITY profile needs it, and only a suite that sends signed requests
   * INTO the home: there the home's row for a remote is keyed by the remote's
   * transport origin, while the remote signs as its identity origin. See the
   * header comment.
   */
  reverse?: boolean;
}

async function bootAndPeer(
  remoteCount: number,
  options: BootOptions,
  peering: PeeringOptions = {},
): Promise<PeeredHarness> {
  const { dialOrigins, beforePeering, reverse } = peering;
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
      if (reverse) {
        const back = await initiatePeering(remote, harness.remoteAdminTokens[i]!, m.home);
        if (back.status !== 200 || back.body.verified !== true) {
          throw new Error(
            `real handshake ${remote.origin} -> home failed: ${back.status} ${JSON.stringify(back.body)}`,
          );
        }
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
export async function bootIdentityPeered(
  remoteCount = 1,
  peering: Pick<PeeringOptions, 'reverse'> = {},
): Promise<PeeredHarness> {
  return bootAndPeer(remoteCount, { publicOriginAsTransport: false }, peering);
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
  opts: { sourceInstance?: string; capabilities?: string[] } = {},
): Promise<RelayPostResult> {
  const payload = JSON.stringify({
    version: 1,
    sourceInstance: opts.sourceInstance ?? signerOrigin,
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
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

/**
 * The relay events an instance's REAL send path queued in its outbox for one
 * conversation, rebuilt the way the outbox worker rebuilds them, oldest first.
 *
 * In the IDENTITY profile an instance's outbox rows target the peer's identity
 * origin, which no socket answers, so the worker cannot deliver them. A suite
 * that needs a real sender and a real receiver reads the events here and posts
 * them with `postSignedRelay`; only the worker's HTTP POST is stood in for.
 */
export function queuedRelayEvents(
  inst: SpawnedInstance,
  contextId: string,
  eventType: string,
): FederationRelayEvent[] {
  const rows = readDb(inst, db =>
    db.prepare(`
      SELECT entity_id AS entityId, event_type AS eventType, context_id AS contextId,
             created_at AS createdAt, payload
      FROM federation_outbox
      WHERE context_id = ? AND event_type = ?
      ORDER BY created_at ASC
    `).all(contextId, eventType) as {
      entityId: string; eventType: string; contextId: string; createdAt: number; payload: string;
    }[],
  );
  return rows.map(row => ({
    ...(JSON.parse(row.payload) as Partial<FederationRelayEvent>),
    eventType: row.eventType as FederationRelayEvent['eventType'],
    contextType: 'dm',
    dmChannelId: row.contextId,
    messageId: row.entityId,
    encryptionVersion: 0,
    timestamp: row.createdAt,
  }));
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

/** What a relay wait is about, for `waitForRelay` and its failure report. */
export interface RelayWait {
  /** The instance whose outbox worker sends the relay. */
  sender: SpawnedInstance;
  /** The instance the relay should land on. */
  receiver: SpawnedInstance;
  /**
   * The origin the sender addresses the receiver by, when that is not
   * `receiver.origin` (a suite that peers through a `RelayTap` passes the tap's
   * origin). Only used to point the report at the right peer row.
   */
  peerOrigin?: string;
  /** What should have arrived, in words: the first line of the failure. */
  what: string;
  /** Default 15 s: many outbox ticks, well inside every suite's test timeout. */
  timeoutMs?: number;
}

/**
 * Poll `check` until the relay it describes has landed. On timeout, throw an
 * error that carries `describeRelayState`, so a CI failure says where the
 * relay stopped instead of only that it did.
 *
 * Use this for every wait on a relay the outbox worker delivers; a bare
 * `waitUntil` is for waits that involve no worker.
 */
export async function waitForRelay(
  check: () => boolean | Promise<boolean>,
  wait: RelayWait,
): Promise<void> {
  const timeoutMs = wait.timeoutMs ?? 15_000;
  if (await waitUntil(check, timeoutMs)) return;
  throw new Error(
    `Relay did not arrive within ${timeoutMs} ms: ${wait.what}\n\n${await describeRelayState(wait)}`,
  );
}

/**
 * How many outbox rows `sender` holds for the peer it knows as `peerOrigin`.
 * A row leaves the outbox when the peer accepts it or rejects it terminally,
 * and stays while it is on the wire, so zero means every relay to that peer
 * has been sent AND settled.
 */
export function outboxRowCount(sender: SpawnedInstance, peerOrigin: string): number {
  return readDb(sender, db =>
    (db.prepare(`
      SELECT COUNT(*) AS n FROM federation_outbox o
      JOIN federation_peers p ON p.id = o.peer_id
      WHERE p.origin = ?
    `).get(peerOrigin) as { n: number }).n,
  );
}

/**
 * Wait until `sender` has nothing queued or in flight for the receiver. For a
 * test that must start from a quiet link, for example before holding the
 * peer's answers at a tap.
 */
export async function waitForOutboxDrained(wait: RelayWait): Promise<void> {
  const peerOrigin = wait.peerOrigin ?? wait.receiver.origin;
  await waitForRelay(() => outboxRowCount(wait.sender, peerOrigin) === 0, wait);
}

/** Lines of each instance's log a failure report quotes. */
const REPORT_LOG_LINES = 40;
/** A log line is cut here, so one request dump cannot drown the report. */
const REPORT_LINE_CHARS = 400;

function relativeTime(at: number | null, now: number): string {
  if (at === null) return 'never';
  const seconds = ((at - now) / 1000).toFixed(1);
  return at >= now ? `in ${seconds}s` : `${seconds.replace('-', '')}s ago`;
}

/**
 * One log line, readable: Fastify's JSON request records become
 * `<time> <reqId> POST /api/federation/relay` and `<time> <reqId> -> 200 (2ms)`;
 * the worker's own plain lines are kept as they are.
 */
function condenseLogLine(line: string): string {
  if (line.startsWith('{')) {
    try {
      const rec = JSON.parse(line) as {
        time?: number; reqId?: string; msg?: string; responseTime?: number;
        req?: { method?: string; url?: string }; res?: { statusCode?: number };
      };
      const at = typeof rec.time === 'number' ? new Date(rec.time).toISOString().slice(11, 23) : '';
      if (rec.req) return `${at} ${rec.reqId ?? ''} ${rec.req.method ?? ''} ${rec.req.url ?? ''}`;
      if (rec.res) {
        const ms = typeof rec.responseTime === 'number' ? ` (${rec.responseTime.toFixed(0)}ms)` : '';
        return `${at} ${rec.reqId ?? ''} -> ${rec.res.statusCode ?? '?'}${ms}`;
      }
      return `${at} ${rec.msg ?? line}`;
    } catch {
      // Not JSON after all; quote it as written.
    }
  }
  return line.length > REPORT_LINE_CHARS ? `${line.slice(0, REPORT_LINE_CHARS)} ...` : line;
}

function logTail(log: string): string {
  const lines = log.split('\n').filter(line => line.trim() !== '');
  const tail = lines.slice(-REPORT_LOG_LINES).map(condenseLogLine);
  return tail.length > 0 ? tail.map(line => `    ${line}`).join('\n') : '    (empty)';
}

/**
 * The sender's side of a relay, as text for a failure message:
 * - every peer row it holds (status, failure counters, last seen/failed,
 *   probe pacing), the receiver's marked;
 * - every outbox row it holds for the receiver's peer row (event type,
 *   entity, attempts, next retry, age), plus a count of rows for other peers.
 *   The outbox has no delivered flag: a row is deleted when the peer accepts
 *   it or rejects it terminally, so "no row" means nothing is waiting;
 * - the tail of the sender's and the receiver's logs, where the worker writes
 *   every failed attempt and every rejection with its reason. The logs live in
 *   the run directory, which `cleanup()` deletes, so the tail is quoted here.
 */
export async function describeRelayState(wait: RelayWait): Promise<string> {
  const { sender, receiver } = wait;
  const peerOrigin = wait.peerOrigin ?? receiver.origin;
  const now = Date.now();
  const out: string[] = [];

  try {
    const peers = readDb(sender, db =>
      db.prepare(`
        SELECT id, origin, status, consecutive_failures AS failures,
               consecutive_auth_failures AS authFailures, last_seen_at AS lastSeenAt,
               last_failure_at AS lastFailureAt, probe_attempts AS probeAttempts,
               last_probe_at AS lastProbeAt
        FROM federation_peers ORDER BY origin
      `).all() as {
        id: string; origin: string; status: string; failures: number; authFailures: number;
        lastSeenAt: number | null; lastFailureAt: number | null; probeAttempts: number;
        lastProbeAt: number | null;
      }[],
    );
    out.push(`Sender ${sender.domain} (${sender.origin}) peer rows:`);
    if (peers.length === 0) out.push('  (none)');
    for (const p of peers) {
      out.push(
        `  ${p.origin === peerOrigin ? '->' : '  '} ${p.origin} status=${p.status} ` +
        `failures=${p.failures} authFailures=${p.authFailures} ` +
        `lastSeen=${relativeTime(p.lastSeenAt, now)} lastFailure=${relativeTime(p.lastFailureAt, now)} ` +
        `probeAttempts=${p.probeAttempts} lastProbe=${relativeTime(p.lastProbeAt, now)}`,
      );
    }

    const target = peers.find(p => p.origin === peerOrigin);
    const rows = readDb(sender, db =>
      db.prepare(`
        SELECT peer_id AS peerId, event_type AS eventType, context_type AS contextType,
               entity_id AS entityId, attempts, next_retry_at AS nextRetryAt,
               created_at AS createdAt
        FROM federation_outbox ORDER BY created_at
      `).all() as {
        peerId: string; eventType: string; contextType: string; entityId: string;
        attempts: number | null; nextRetryAt: number; createdAt: number;
      }[],
    );
    const forPeer = target ? rows.filter(r => r.peerId === target.id) : [];
    out.push(`Sender outbox rows for ${peerOrigin}${target ? '' : ' (the sender has NO peer row for this origin)'}:`);
    if (forPeer.length === 0) {
      out.push('  (none: nothing waiting; accepted and terminally rejected rows are deleted)');
    }
    for (const r of forPeer) {
      out.push(
        `  ${r.eventType} [${r.contextType}] entity=${r.entityId} attempts=${r.attempts ?? 0} ` +
        `nextRetry=${relativeTime(r.nextRetryAt, now)} created=${relativeTime(r.createdAt, now)}`,
      );
    }
    const others = rows.length - forPeer.length;
    if (others > 0) out.push(`  (${others} more row(s) queued for other peers)`);
  } catch (err) {
    out.push(`Could not read ${sender.domain}'s database: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const [role, inst] of [['Sender', sender], ['Receiver', receiver]] as const) {
    out.push(`${role} ${inst.domain} log (${inst.logPath}, deleted at cleanup), last ${REPORT_LOG_LINES} lines:`);
    out.push(logTail(await readInstanceLog(inst)));
  }
  return out.join('\n');
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
