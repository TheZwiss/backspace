import type { FastifyInstance } from 'fastify';
import type { DirectoryDocument, DirectoryFeed } from '@backspace/shared';
import { getRawDb } from '../db/index.js';
import { config } from '../config.js';
import { buildDirectoryDocument } from '../directory/document.js';
import { getDocumentVersion, readDirectoryBrowseEnabled } from '../directory/state.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { resolveLocalOrigin } from './federation/origin.js';

/**
 * How long a built document is served before it is rebuilt, whether or not
 * anything changed. The hub fetches from many Cloudflare addresses, so the
 * per-user-or-IP rate limiter is no guard against a distributed reader; this
 * cache is. A change (markDirectoryDirty) drops it sooner, so the document
 * served is never older than the last change.
 */
const DOCUMENT_CACHE_MS = 30_000;

interface DocumentCache {
  version: number;
  at: number;
  doc: DirectoryDocument;
}

let cache: DocumentCache | null = null;

function getDocument(): DirectoryDocument {
  const version = getDocumentVersion();
  const now = Date.now();
  if (cache !== null && cache.version === version && now - cache.at < DOCUMENT_CACHE_MS) {
    return cache.doc;
  }
  const doc = buildDirectoryDocument(getRawDb(), { origin: resolveLocalOrigin(), version: config.version });
  cache = { version, at: now, doc };
  return doc;
}

export function _resetDirectoryRouteCacheForTests(): void {
  cache = null;
}

/**
 * The feed proxy. The browser never talks to the hub; it reads the feed
 * through its own instance, which validates the query, forwards it, and keeps
 * each distinct query for a minute so a delist reaches clients within about
 * that long while the hub sees one read per query per instance per minute.
 *
 * The hub caches the feed at its edge for the same minute and reports the
 * copy's age in `Age` (seconds; absent on a miss). The minute here counts
 * from when the edge copy was made, not from when it arrived, so the two
 * caches never stack into two minutes: freshness is bounded at 60 s end to
 * end. The upstream `cache-control` is not read for this, since the CDN
 * rewrites it to its browser-facing value on a hit.
 */
const FEED_CACHE_MS = 60_000;
const FEED_CACHE_MAX_ENTRIES = 64;
const FEED_TIMEOUT_MS = 10_000;
const FEED_QUERY_MAX_CHARS = 100;
const FEED_LIMIT_DEFAULT = 50;
const FEED_LIMIT_MIN = 1;
const FEED_LIMIT_MAX = 100;
const FEED_OFFSET_MIN = 0;
const FEED_OFFSET_MAX = 1000;

interface FeedQuery {
  q: string;
  limit: number;
  offset: number;
}

interface FeedCacheEntry {
  at: number;
  feed: DirectoryFeed;
}

/** Insertion-ordered; the oldest entry goes when the map is full. */
const feedCache = new Map<string, FeedCacheEntry>();
/** One upstream fetch per query at a time; identical requests share it. */
const feedInflight = new Map<string, Promise<DirectoryFeed | null>>();

export function _resetDirectoryProxyForTests(): void {
  feedCache.clear();
  feedInflight.clear();
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clampInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Out-of-range values are clamped rather than rejected: the hub applies the
 * same bounds, and a client that asks for too much gets the most it can have.
 */
function parseFeedQuery(raw: Record<string, unknown>): FeedQuery {
  const q = (firstString(raw['q']) ?? '').trim().slice(0, FEED_QUERY_MAX_CHARS);
  const limit = clampInteger(firstString(raw['limit']), FEED_LIMIT_DEFAULT, FEED_LIMIT_MIN, FEED_LIMIT_MAX);
  const offset = clampInteger(firstString(raw['offset']), FEED_OFFSET_MIN, FEED_OFFSET_MIN, FEED_OFFSET_MAX);
  return { q, limit, offset };
}

function feedCacheKey(query: FeedQuery): string {
  return `${query.limit}:${query.offset}:${query.q}`;
}

function feedUrl(endpoint: string, query: FeedQuery): string {
  const url = new URL(`${endpoint}/v1/spaces`);
  if (query.q !== '') url.searchParams.set('q', query.q);
  url.searchParams.set('limit', String(query.limit));
  url.searchParams.set('offset', String(query.offset));
  return url.href;
}

function isDirectoryFeed(value: unknown): value is DirectoryFeed {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { schema?: unknown; spaces?: unknown };
  return candidate.schema === 1
    && Array.isArray(candidate.spaces)
    && candidate.spaces.every((entry) => typeof entry === 'object' && entry !== null);
}

interface FetchedFeed {
  feed: DirectoryFeed;
  /** How old the hub's copy already was when it answered, in ms; 0 when it did not say. */
  ageMs: number;
}

/**
 * The `Age` header as milliseconds. Absent or not a whole number of seconds
 * counts as 0; a value beyond the proxy's own TTL is clamped to it, so the
 * stored instant is never further back than one full TTL.
 */
function ageMsOf(response: Response): number {
  const raw = response.headers.get('age');
  if (raw === null) return 0;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds * 1000, FEED_CACHE_MS);
}

/** Null on any failure: no answer, a non-200, or a body that is not a feed. */
async function fetchFeed(endpoint: string, query: FeedQuery): Promise<FetchedFeed | null> {
  let response: Response;
  try {
    response = await fetch(feedUrl(endpoint, query), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': `backspace-server/${config.version}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (response.status !== 200) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return isDirectoryFeed(body) ? { feed: body, ageMs: ageMsOf(response) } : null;
}

/** `at` is when the copy was made: the receive time less the hub's `Age`. */
function storeFeed(key: string, feed: DirectoryFeed, at: number): void {
  if (feedCache.size >= FEED_CACHE_MAX_ENTRIES) {
    const oldest = feedCache.keys().next();
    if (!oldest.done) feedCache.delete(oldest.value);
  }
  feedCache.set(key, { at, feed });
}

/**
 * Cache first, then a shared in-flight fetch, then upstream. A failure is not
 * cached: the next request tries again, and the route limiter bounds how
 * often that happens.
 */
function getFeed(endpoint: string, query: FeedQuery): Promise<DirectoryFeed | null> {
  const key = feedCacheKey(query);
  const now = Date.now();
  const hit = feedCache.get(key);
  if (hit !== undefined) {
    if (now - hit.at < FEED_CACHE_MS) return Promise.resolve(hit.feed);
    feedCache.delete(key);
  }
  const pending = feedInflight.get(key);
  if (pending !== undefined) return pending;

  const request = fetchFeed(endpoint, query)
    .then((fetched) => {
      if (fetched === null) return null;
      storeFeed(key, fetched.feed, Date.now() - fetched.ageMs);
      return fetched.feed;
    })
    .finally(() => {
      feedInflight.delete(key);
    });
  feedInflight.set(key, request);
  return request;
}

export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/directory/spaces: the public document the hub indexes. No auth
  // on purpose; the hub is a stranger. It never 404s (a switched-off
  // instance serves an empty list), so a fetch of one is a success that
  // clears its rows at the hub. Served no-cache so no intermediary can hold
  // a pre-delist copy; the in-memory cache above answers the revalidations
  // and is the actual polling guard.
  app.get('/api/directory/spaces', async (_request, reply) => {
    const doc = getDocument();
    return reply
      .code(200)
      .header('cache-control', 'no-cache')
      .send(doc);
  });

  // GET /api/directory?q=&limit=&offset=: the hub's feed, read through this
  // instance. Its own limiter sits under the global one because distinct
  // queries miss the cache, and the global 200 per minute would let one user
  // drive a few hundred thousand hub reads a day through their instance.
  app.get<{ Querystring: Record<string, unknown> }>('/api/directory', {
    preHandler: authenticate,
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const endpoint = config.directory.endpoint;
    // Two switches, one answer. The operator's endpoint decides whether this
    // instance can reach a directory at all; the admin's browse flag decides
    // whether the people here look at one. Either being off is the same
    // "there is no directory here" the client already knows how to render,
    // and both are read before any fetch or cache lookup.
    if (endpoint === '' || !readDirectoryBrowseEnabled(getRawDb())) return sendError(reply, 404, 'directory_disabled');
    const feed = await getFeed(endpoint, parseFeedQuery(request.query));
    if (feed === null) return sendError(reply, 502, 'directory_unreachable');
    return reply.code(200).send(feed);
  });
}
