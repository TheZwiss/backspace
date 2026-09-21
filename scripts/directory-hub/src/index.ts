import type { Env } from './env';
import { parseOrigin, parseDocument, MAX_PING_BYTES, MAX_DOCUMENT_BYTES } from './validate';
import type { AvatarColor } from './validate';
import { documentHash } from './hash';
import {
  applyDocument,
  deleteOlderThan,
  feed,
  getLastFetchAt,
  readOriginHash,
  touchFetchAttempt,
  touchOriginOk,
} from './store';
import type { FeedRow } from './store';

/**
 * The directory hub. Two routes and a cron, in the order of section 7 of
 * docs/superpowers/specs/2026-09-21-space-directory-design.md:
 *
 * - `POST /v1/ping` takes an origin, fetches that origin's own directory
 *   document, validates it and stores it as a diff. The hub never lists
 *   anything an instance did not publish itself, and the pinger learns from
 *   the status why a listing did not go through.
 * - `GET /v1/spaces` is the public feed, cached at the edge for a minute.
 * - The daily cron drops origins nobody has confirmed alive for 30 days.
 *
 * The outbound fetch is a parameter of `createWorker`, so the tests hand in a
 * spy and assert on the request the hub would have sent.
 */

/** The path every instance serves its document on; section 5 of the spec. */
const DOCUMENT_PATH = '/api/directory/spaces';

/** Ping step 4: one fetch per origin per this many milliseconds, whoever asks. */
const ORIGIN_COOLDOWN_MS = 10_000;

/** Ping step 5. */
const FETCH_TIMEOUT_MS = 10_000;

const FEED_QUERY_MAX_CHARS = 100;
const FEED_LIMIT_DEFAULT = 50;
const FEED_LIMIT_MIN = 1;
const FEED_LIMIT_MAX = 100;
const FEED_OFFSET_MIN = 0;
const FEED_OFFSET_MAX = 1000;

/** How long a feed answer lives in `caches.default` and in every instance's proxy cache. */
const FEED_CACHE_SECONDS = 60;

const MS_PER_DAY = 86_400_000;

/** An origin drops off the feed this long after its last valid document. */
const FEED_CUTOFF_MS = 3 * MS_PER_DAY;

/** And out of the database this long after; housekeeping, not visible to users. */
const RETENTION_MS = 30 * MS_PER_DAY;

/**
 * The Worker's two entry points, with the plain `Request` the tests build
 * rather than the `IncomingRequestCfProperties` flavour `ExportedHandler`
 * would infer; `satisfies` below checks the object against that anyway.
 */
export interface HubWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
}

/** Why a ping could not be listed. The pinger keeps its dirty flag on any of these. */
type PingFailure = 'unreachable' | 'status' | 'invalid' | 'origin-mismatch';

/** One feed entry, the `DirectoryEntry` shape of the shared types in camel case. */
interface FeedEntry {
  origin: string;
  instanceName: string;
  federatedRegistrationOpen: boolean;
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  avatarColor: AvatarColor | null;
  visibility: 'public' | 'request';
  memberCount: number;
  createdAt: number;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function failure(reason: PingFailure): Response {
  return json(502, { reason }, { 'cache-control': 'no-store' });
}

/**
 * The per-address limiter, ping step 2 and the feed's second guard. The
 * source address is read here and nowhere else: it is the limiter key, it
 * is never stored and never leaves this function. Absent binding, no limit;
 * `wrangler dev` without the binding still serves.
 */
async function limitByAddress(request: Request, env: Env): Promise<Response | null> {
  if (!env.RATE_LIMITER) return null;
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.RATE_LIMITER.limit({ key });
  return success ? null : new Response(null, { status: 429 });
}

/**
 * Reads the ping body under `MAX_PING_BYTES`. A `Content-Length` over the cap
 * is refused without reading; otherwise the body is read in full and measured
 * afterwards, so a lying or absent header changes nothing. The code-unit
 * check is the cheap one and never over-rejects, since a string of N code
 * units encodes to at least N bytes; the encoded measurement decides.
 */
async function readPingBody(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_PING_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_PING_BYTES) return null;
  if (new TextEncoder().encode(text).byteLength > MAX_PING_BYTES) return null;
  return text;
}

/** The `origin` field of a ping body that is `{ schema: 1, origin: string }`, else null. */
function pingOrigin(text: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (body['schema'] !== 1) return null;
  return body['origin'] ?? null;
}

/**
 * Reads a response body as text under `MAX_DOCUMENT_BYTES`, ping step 5.
 *
 * `Content-Length` is checked first, so a body that announces itself as too
 * large costs nothing. Then the body is read chunk by chunk and the stream is
 * cancelled the moment the running total passes the cap, so an instance that
 * streams a gigabyte makes the hub hold at most the cap plus one chunk.
 * `response.text()` would buffer the whole thing before anything could be
 * measured. Returns null when the cap was passed.
 */
async function readBounded(response: Response): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Fetches `origin`'s document and returns its text, or the reason it could
 * not be had. A redirect is a failure by policy: `redirect: 'manual'` hands
 * the 3xx back as the response and the status check refuses it, so the hub
 * never follows a listing instance anywhere else. A body that fails to
 * arrive, whether the connection dropped or the timeout cut it, counts as
 * unreachable like a connection that never opened.
 */
async function fetchDocument(
  outbound: typeof fetch,
  origin: string,
): Promise<{ ok: true; text: string } | { ok: false; reason: PingFailure }> {
  let response: Response;
  try {
    response = await outbound(`${origin}${DOCUMENT_PATH}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { ok: false, reason: 'status' };
  }
  let text: string | null;
  try {
    text = await readBounded(response);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (text === null) return { ok: false, reason: 'invalid' };
  return { ok: true, text };
}

/** `POST /v1/ping`, steps 1 to 8 of section 7 in that order. */
export async function handlePing(request: Request, env: Env, outbound: typeof fetch): Promise<Response> {
  // Step 1. Retired: the pinger reads 410 as "stop asking".
  if (env.RETIRED === '1') return new Response(null, { status: 410 });

  // Step 2.
  const limited = await limitByAddress(request, env);
  if (limited !== null) return limited;

  // Step 3. The hub's own host is what a ping may not name; without HUB_HOST
  // it is the host this request arrived on.
  const text = await readPingBody(request);
  if (text === null) return new Response(null, { status: 400 });
  const selfHost = env.HUB_HOST ?? new URL(request.url).hostname;
  const parsed = parseOrigin(pingOrigin(text), selfHost);
  if (!parsed.ok) return new Response(null, { status: 400 });
  const { origin } = parsed;

  // Step 4. The attempt is recorded before the fetch, so a failed one counts.
  const now = Date.now();
  const lastFetchAt = await getLastFetchAt(env.DB, origin);
  if (lastFetchAt !== null && now - lastFetchAt < ORIGIN_COOLDOWN_MS) {
    return new Response(null, {
      status: 429,
      headers: { 'retry-after': String(ORIGIN_COOLDOWN_MS / 1000) },
    });
  }
  await touchFetchAttempt(env.DB, origin, now);

  // Steps 5 and 8.
  const fetched = await fetchDocument(outbound, origin);
  if (!fetched.ok) return failure(fetched.reason);

  // Step 6.
  const result = parseDocument(fetched.text, origin);
  if (!result.ok) return failure(result.reason);

  // Step 7. Same hash: the origin is alive and nothing else changed, one row.
  const hash = await documentHash(result.doc);
  const okAt = Date.now();
  if ((await readOriginHash(env.DB, origin)) === hash) {
    await touchOriginOk(env.DB, origin, okAt);
  } else {
    await applyDocument(env.DB, origin, result.doc, hash, okAt);
  }
  return new Response(null, { status: 204 });
}

function clampInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toEntry(row: FeedRow): FeedEntry {
  return {
    origin: row.origin,
    instanceName: row.instance_name,
    federatedRegistrationOpen: row.federated_registration_open === 1,
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    banner: row.banner,
    avatarColor: row.avatar_color,
    visibility: row.visibility,
    memberCount: row.member_count,
    createdAt: row.created_at,
  };
}

/**
 * `GET /v1/spaces`. Out-of-range values are clamped rather than rejected, the
 * same rule the instance proxy applies before it forwards a query, so the
 * two agree on what a request means. The answer goes through
 * `caches.default`: a `Cache-Control` header alone does not put a Worker
 * response in Cloudflare's cache, and the feed is read by every instance's
 * proxy once a minute per distinct query.
 */
async function handleFeed(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const limited = await limitByAddress(request, env);
  if (limited !== null) return limited;

  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? '').trim().slice(0, FEED_QUERY_MAX_CHARS);
  const limit = clampInteger(searchParams.get('limit'), FEED_LIMIT_DEFAULT, FEED_LIMIT_MIN, FEED_LIMIT_MAX);
  const offset = clampInteger(searchParams.get('offset'), FEED_OFFSET_MIN, FEED_OFFSET_MIN, FEED_OFFSET_MAX);

  const rows = await feed(env.DB, { q, limit, offset, since: Date.now() - FEED_CUTOFF_MS });
  const response = json(200, { schema: 1, spaces: rows.map(toEntry) }, {
    'cache-control': `public, max-age=${FEED_CACHE_SECONDS}`,
    'x-content-type-options': 'nosniff',
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

/**
 * Builds the Worker around an outbound fetch. Production uses the global
 * one; the tests pass a spy. The default is wrapped rather than passed as
 * `globalThis.fetch` itself so the call never depends on how the runtime
 * treats a detached global.
 */
export function createWorker(outbound: typeof fetch = (input, init) => globalThis.fetch(input, init)): HubWorker {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === 'POST' && pathname === '/v1/ping') return handlePing(request, env, outbound);
      if (request.method === 'GET' && pathname === '/v1/spaces') return handleFeed(request, env, ctx);
      return new Response(null, { status: 404 });
    },

    /**
     * Daily housekeeping. The cutoff is derived from the trigger's own time
     * rather than `Date.now()`, so a run the platform queued and started late
     * deletes exactly what it was scheduled to delete. The count includes the
     * `spaces` rows the foreign key cascaded.
     */
    async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
      const removed = await deleteOlderThan(env.DB, controller.scheduledTime - RETENTION_MS);
      console.log(`directory hub housekeeping: ${removed} rows removed`);
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
