import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { Env } from './env';
import { createWorker } from './index';
import { applyDocument } from './store';
import { documentHash } from './hash';
import type { ValidDocument, ValidSpace } from './validate';

const HUB = 'https://explore.test';
const ORIGIN = 'https://chat.example.org';
const DOCUMENT_URL = `${ORIGIN}/api/directory/spaces`;
const DAY = 86_400_000;

type Outbound = typeof fetch;
type OutboundSpy = Mock<Outbound>;

/**
 * Every request built by `post()` and `get()` gets its own source address.
 *
 * The rate-limit binding miniflare builds from `wrangler.toml` is the live one,
 * 2 requests per 10 seconds. Without a `cf-connecting-ip` header the Worker
 * keys every request as `unknown`, so the whole file would share one bucket
 * and the third request of the suite would get a 429 from a limiter the test
 * was not about. Addresses come from 203.0.113.0/24, the TEST-NET-3
 * documentation range.
 */
let nextAddress = 0;

function address(): string {
  nextAddress += 1;
  return `203.0.113.${nextAddress}`;
}

function post(body: string, url = `${HUB}/v1/ping`): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': address() },
    body,
  });
}

function get(url: string): Request {
  return new Request(url, { headers: { 'cf-connecting-ip': address() } });
}

/**
 * Every feed read gets a query string of its own. The Cache API works in the
 * pool but its isolated-storage rollback between tests is not guaranteed, so
 * a URL read in one test must never be read again in another. The handler
 * ignores `t`.
 */
let nextFeedRead = 0;

function feedUrl(params: Record<string, string> = {}): string {
  nextFeedRead += 1;
  const url = new URL(`${HUB}/v1/spaces`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('t', String(nextFeedRead));
  return url.href;
}

function ping(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 1, origin: ORIGIN, ...over });
}

function space(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'space-1',
    name: 'Kobold Lounge',
    description: 'A place for kobolds.',
    icon: `${ORIGIN}/api/uploads/icon.png`,
    banner: null,
    avatarColor: 'mint',
    visibility: 'public',
    memberCount: 12,
    createdAt: 1758400000000,
    ...over,
  };
}

function document(over: Record<string, unknown> = {}, spaces: Record<string, unknown>[] = [space()]): string {
  return JSON.stringify({
    schema: 1,
    origin: ORIGIN,
    instance: { name: 'Kobold Truppe', federatedRegistrationOpen: true, version: '1.4.0' },
    spaces,
    ...over,
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** An outbound fetch that answers every call with `make()`. */
function answering(make: () => Response | Promise<Response>): OutboundSpy {
  return vi.fn<Outbound>(async () => make());
}

async function call(outbound: OutboundSpy, req: Request, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await createWorker(outbound).fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function readJson(res: Response): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await res.arrayBuffer()));
}

/** The init object the spy was called with, typed for the assertions below. */
function initOf(spy: OutboundSpy, callIndex = 0): RequestInit {
  const init = spy.mock.calls[callIndex]?.[1];
  if (init === undefined) throw new Error('the outbound fetch was called without an init');
  return init;
}

/** Moves an origin's cooldown into the past so the next ping for it is not a 429. */
async function expireCooldown(origin: string): Promise<void> {
  await env.DB.prepare('UPDATE fetch_attempts SET last_fetch_at = last_fetch_at - 20000 WHERE origin = ?1').bind(origin).run();
}

interface SpaceRow {
  origin: string;
  id: string;
  row_hash: string;
  name: string;
  member_count: number;
}

interface OriginRow {
  origin: string;
  instance_name: string;
  federated_registration_open: number;
  version: string | null;
  document_hash: string;
  first_seen_at: number;
  last_ok_at: number;
}

async function spaceRows(origin: string): Promise<SpaceRow[]> {
  const { results } = await env.DB
    .prepare('SELECT origin, id, row_hash, name, member_count FROM spaces WHERE origin = ?1 ORDER BY id')
    .bind(origin)
    .all<SpaceRow>();
  return results;
}

async function originRow(origin: string): Promise<OriginRow | null> {
  return env.DB.prepare('SELECT * FROM origins WHERE origin = ?1').bind(origin).first<OriginRow>();
}

async function fetchAttempt(origin: string): Promise<number | null> {
  const row = await env.DB
    .prepare('SELECT last_fetch_at FROM fetch_attempts WHERE origin = ?1')
    .bind(origin)
    .first<{ last_fetch_at: number }>();
  return row === null ? null : row.last_fetch_at;
}

function validSpace(over: Partial<ValidSpace> = {}): ValidSpace {
  return {
    id: 'a',
    name: 'Alpha',
    description: null,
    icon: null,
    banner: null,
    avatarColor: null,
    visibility: 'public',
    memberCount: 1,
    createdAt: 1_000,
    ...over,
  };
}

/** Writes a document for `origin` straight into the store, bypassing the ping route. */
async function seed(origin: string, spaces: ValidSpace[], lastOkAt: number): Promise<void> {
  const doc: ValidDocument = { instanceName: 'Seeded', federatedRegistrationOpen: false, version: null, spaces };
  await applyDocument(env.DB, origin, doc, await documentHash(doc), lastOkAt);
}

/** A successful ping for ORIGIN with the default document, with the cooldown cleared afterwards. */
async function listDefault(): Promise<void> {
  const res = await call(answering(() => jsonResponse(document())), post(ping()));
  expect(res.status).toBe(204);
  await expireCooldown(ORIGIN);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM spaces'),
    env.DB.prepare('DELETE FROM origins'),
    env.DB.prepare('DELETE FROM fetch_attempts'),
    env.DB.prepare('DELETE FROM blocks'),
  ]);
});

describe('POST /v1/ping', () => {
  it('answers 410 when retired, before reading anything', async () => {
    const spy = answering(() => jsonResponse(document()));
    const res = await call(spy, post(ping()), { ...env, RETIRED: '1' });
    expect(res.status).toBe(410);
    expect(spy).not.toHaveBeenCalled();
    expect(await fetchAttempt(ORIGIN)).toBeNull();
  });

  it('answers 429 when the per-address limiter says no, without fetching', async () => {
    const spy = answering(() => jsonResponse(document()));
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await call(spy, post(ping()), { ...env, RATE_LIMITER: limiter });
    expect(res.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
    expect(await fetchAttempt(ORIGIN)).toBeNull();
  });

  it('keys the limiter on the connecting address and stores nothing of it', async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async (options: { key: string }) => {
        keys.push(options.key);
        return { success: true };
      },
    } as unknown as RateLimit;
    const req = post(ping());
    req.headers.set('cf-connecting-ip', '203.0.113.250');
    const res = await call(answering(() => jsonResponse(document())), req, { ...env, RATE_LIMITER: limiter });
    expect(res.status).toBe(204);
    expect(keys).toEqual(['203.0.113.250']);
    const dump = await env.DB.prepare('SELECT * FROM origins, spaces, fetch_attempts').all();
    expect(JSON.stringify(dump.results)).not.toContain('203.0.113.250');
  });

  it('answers 400 to a body over 1024 bytes', async () => {
    const spy = answering(() => jsonResponse(document()));
    const res = await call(spy, post(ping({ pad: 'x'.repeat(1100) })));
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    expect(await fetchAttempt(ORIGIN)).toBeNull();
  });

  it('measures the body in encoded bytes, not code units', async () => {
    // 600 two-byte characters is 600 code units and 1200 bytes.
    const spy = answering(() => jsonResponse(document()));
    const body = ping({ pad: 'é'.repeat(600) });
    expect(body.length).toBeLessThan(1024);
    const res = await call(spy, post(body));
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers 400 to a body that is not JSON, not schema 1, or without an origin', async () => {
    const spy = answering(() => jsonResponse(document()));
    expect((await call(spy, post('{'))).status).toBe(400);
    expect((await call(spy, post(JSON.stringify({ schema: 2, origin: ORIGIN })))).status).toBe(400);
    expect((await call(spy, post(JSON.stringify({ schema: 1 })))).status).toBe(400);
    expect((await call(spy, post(JSON.stringify({ schema: 1, origin: 7 })))).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    expect(await fetchAttempt(ORIGIN)).toBeNull();
  });

  it('answers 400 to an origin the validator rejects', async () => {
    const spy = answering(() => jsonResponse(document()));
    const res = await call(spy, post(ping({ origin: 'http://chat.example.org' })));
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to fetch itself, by HUB_HOST when set and by the request host otherwise', async () => {
    const spy = answering(() => jsonResponse(document()));
    // No HUB_HOST in the test env: the host of the request being answered is the hub.
    expect((await call(spy, post(ping({ origin: HUB })))).status).toBe(400);
    expect((await call(spy, post(ping({ origin: 'https://Explore.Test/' })))).status).toBe(400);
    // With HUB_HOST set, that host is the hub whatever the request says.
    const hub = { ...env, HUB_HOST: 'explore.backspacechat.com' };
    expect((await call(spy, post(ping({ origin: 'https://explore.backspacechat.com' })), hub)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches the document URL with a manual redirect policy, a signal, an accept header and no store', async () => {
    const spy = answering(() => jsonResponse(document()));
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(DOCUMENT_URL);
    const init = initOf(spy);
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(init.cache).toBe('no-store');
  });

  it('canonicalises the pinged origin before fetching and storing', async () => {
    const spy = answering(() => jsonResponse(document()));
    const res = await call(spy, post(ping({ origin: 'HTTPS://Chat.Example.org/' })));
    expect(res.status).toBe(204);
    expect(spy.mock.calls[0]?.[0]).toBe(DOCUMENT_URL);
    expect((await originRow(ORIGIN))?.origin).toBe(ORIGIN);
  });

  it('answers 204 to a valid document and the feed then lists its spaces', async () => {
    const spy = answering(() => jsonResponse(document()));
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(204);
    expect(await res.arrayBuffer()).toHaveProperty('byteLength', 0);

    const feed = await call(spy, get(feedUrl()));
    expect(feed.status).toBe(200);
    expect(await readJson(feed)).toEqual({
      schema: 1,
      spaces: [{
        origin: ORIGIN,
        instanceName: 'Kobold Truppe',
        federatedRegistrationOpen: true,
        id: 'space-1',
        name: 'Kobold Lounge',
        description: 'A place for kobolds.',
        icon: `${ORIGIN}/api/uploads/icon.png`,
        banner: null,
        avatarColor: 'mint',
        visibility: 'public',
        memberCount: 12,
        createdAt: 1758400000000,
      }],
    });
  });

  it('answers 429 with retry-after 10 to a second ping inside the cooldown, without fetching', async () => {
    const spy = answering(() => jsonResponse(document()));
    expect((await call(spy, post(ping()))).status).toBe(204);
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('records a fetch attempt for an origin that never validated, so its second ping is also 429', async () => {
    const spy = answering(() => jsonResponse('', 500));
    const first = await call(spy, post(ping()));
    expect(first.status).toBe(502);
    expect(await readJson(first)).toEqual({ reason: 'status' });
    expect(await fetchAttempt(ORIGIN)).not.toBeNull();
    expect(await originRow(ORIGIN)).toBeNull();

    const second = await call(spy, post(ping()));
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('10');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lets a ping through once the cooldown has passed', async () => {
    const spy = answering(() => jsonResponse(document()));
    expect((await call(spy, post(ping()))).status).toBe(204);
    await expireCooldown(ORIGIN);
    expect((await call(spy, post(ping()))).status).toBe(204);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('answers 502 status to a redirect and leaves the rows intact', async () => {
    await listDefault();
    const before = { origin: await originRow(ORIGIN), spaces: await spaceRows(ORIGIN) };

    const spy = answering(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ reason: 'status' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect({ origin: await originRow(ORIGIN), spaces: await spaceRows(ORIGIN) }).toEqual(before);
  });

  it('answers 502 status to a non-200 answer', async () => {
    const spy = answering(() => jsonResponse(document(), 404));
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ reason: 'status' });
    expect(await originRow(ORIGIN)).toBeNull();
  });

  it('answers 502 unreachable when the fetch rejects and leaves earlier rows intact', async () => {
    await listDefault();
    const before = { origin: await originRow(ORIGIN), spaces: await spaceRows(ORIGIN) };

    const spy = vi.fn<Outbound>(async () => { throw new TypeError('connect timed out'); });
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ reason: 'unreachable' });
    expect({ origin: await originRow(ORIGIN), spaces: await spaceRows(ORIGIN) }).toEqual(before);
  });

  it('answers 502 invalid to a document that fails validation and leaves the rows intact', async () => {
    await listDefault();
    const before = { origin: await originRow(ORIGIN), spaces: await spaceRows(ORIGIN) };

    const spy = answering(() => jsonResponse(document({}, [space({ memberCount: -1 })])));
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ reason: 'invalid' });
    expect({ origin: await originRow(ORIGIN), spaces: await spaceRows(ORIGIN) }).toEqual(before);
  });

  it('answers 502 invalid to a body that is not JSON', async () => {
    const spy = answering(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ reason: 'invalid' });
    expect(await originRow(ORIGIN)).toBeNull();
  });

  it('answers 502 origin-mismatch to a document for another origin and leaves the rows intact', async () => {
    await listDefault();
    const before = { origin: await originRow(ORIGIN), spaces: await spaceRows(ORIGIN) };

    const spy = answering(() => jsonResponse(document({ origin: 'https://other.example.org' })));
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ reason: 'origin-mismatch' });
    expect({ origin: await originRow(ORIGIN), spaces: await spaceRows(ORIGIN) }).toEqual(before);
  });

  it('cuts off a body that streams past 512 KB and answers 502 invalid without buffering the rest', async () => {
    const CHUNK = 64 * 1024;
    const TOTAL = 1024 * 1024;
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(CHUNK).fill('x'.charCodeAt(0));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
        if (pulled * CHUNK >= TOTAL) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const spy = answering(() => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await call(spy, post(ping()));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ reason: 'invalid' });
    // 9 chunks pass the cap. A stream keeps at most a chunk or two ahead of
    // the reader, so anything near 16 means the whole megabyte was read.
    expect(pulled).toBeLessThanOrEqual(11);
    expect(cancelled).toBe(true);
    expect(await originRow(ORIGIN)).toBeNull();
  });

  it('rejects a body whose content-length is over the cap without reading it', async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const spy = answering(() => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(512 * 1024 + 1) },
    }));
    const res = await call(spy, post(ping()));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ reason: 'invalid' });
    // The stream primes its own queue with one pull at construction, before
    // any reader exists; that pull is not the hub reading. The cancel is.
    expect(pulled).toBeLessThanOrEqual(1);
    expect(cancelled).toBe(true);
  });

  it('answers 204 to an empty spaces list and the feed no longer lists that origin', async () => {
    await listDefault();
    expect(await spaceRows(ORIGIN)).toHaveLength(1);

    const res = await call(answering(() => jsonResponse(document({}, []))), post(ping()));
    expect(res.status).toBe(204);
    expect(await spaceRows(ORIGIN)).toHaveLength(0);
    expect((await originRow(ORIGIN))?.instance_name).toBe('Kobold Truppe');

    const feed = await call(answering(() => jsonResponse(document())), get(feedUrl()));
    expect(await readJson(feed)).toEqual({ schema: 1, spaces: [] });
  });

  it('answers 204 to a document identical to the stored one and updates only last_ok_at', async () => {
    await listDefault();
    const before = await originRow(ORIGIN);
    expect(before).not.toBeNull();
    // Push last_ok_at into the past so the refresh is visible, and tamper with
    // a row: the identical-hash path must not rewrite rows, so the tampering
    // survives if and only if the hub took that path.
    await env.DB.prepare('UPDATE origins SET last_ok_at = last_ok_at - 20000 WHERE origin = ?1').bind(ORIGIN).run();
    await env.DB.prepare("UPDATE spaces SET name = 'tampered' WHERE origin = ?1").bind(ORIGIN).run();

    const res = await call(answering(() => jsonResponse(document())), post(ping()));
    expect(res.status).toBe(204);
    const after = await originRow(ORIGIN);
    expect(after).not.toBeNull();
    if (before === null || after === null) return;
    expect(after.last_ok_at).toBeGreaterThanOrEqual(before.last_ok_at);
    expect({ ...after, last_ok_at: 0 }).toEqual({ ...before, last_ok_at: 0 });
    expect((await spaceRows(ORIGIN))[0]?.name).toBe('tampered');
  });

  it('diffs a changed document into the rows', async () => {
    await listDefault();
    const changed = document({}, [space({ memberCount: 13 }), space({ id: 'space-2', name: 'Second' })]);
    const res = await call(answering(() => jsonResponse(changed)), post(ping()));
    expect(res.status).toBe(204);
    const rows = await spaceRows(ORIGIN);
    expect(rows.map((row) => [row.id, row.member_count])).toEqual([['space-1', 13], ['space-2', 12]]);
  });
});

describe('GET /v1/spaces', () => {
  it('answers the feed envelope with the cache header and content type', async () => {
    const spy = answering(() => jsonResponse(document()));
    const res = await call(spy, get(feedUrl()));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await readJson(res)).toEqual({ schema: 1, spaces: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('clamps limit and offset like the proxy and falls back on garbage', async () => {
    const now = Date.now();
    const spaces = Array.from({ length: 120 }, (_, i) =>
      validSpace({ id: `s${String(i).padStart(3, '0')}`, name: `Space ${i}`, memberCount: 1000 - i }),
    );
    await seed(ORIGIN, spaces, now);
    const spy = answering(() => jsonResponse(document()));

    const count = async (params: Record<string, string>): Promise<number> => {
      const body = (await readJson(await call(spy, get(feedUrl(params))))) as { spaces: unknown[] };
      return body.spaces.length;
    };
    expect(await count({})).toBe(50);
    expect(await count({ limit: '500' })).toBe(100);
    expect(await count({ limit: '0' })).toBe(1);
    expect(await count({ limit: 'abc' })).toBe(50);
    expect(await count({ limit: '100', offset: '100' })).toBe(20);
    expect(await count({ limit: '100', offset: '5000' })).toBe(0);
    expect(await count({ limit: '100', offset: '-5' })).toBe(100);
  });

  it('orders by member count, pages with offset and filters with q', async () => {
    const now = Date.now();
    await seed(ORIGIN, [
      validSpace({ id: 'a', name: 'Chess Club', memberCount: 5 }),
      validSpace({ id: 'b', name: 'Kobolds', description: 'chess and more', memberCount: 9 }),
      validSpace({ id: 'c', name: 'Quiet', memberCount: 7 }),
    ], now);
    const spy = answering(() => jsonResponse(document()));

    const ids = async (params: Record<string, string>): Promise<string[]> => {
      const body = (await readJson(await call(spy, get(feedUrl(params))))) as { spaces: { id: string }[] };
      return body.spaces.map((s) => s.id);
    };
    expect(await ids({})).toEqual(['b', 'c', 'a']);
    expect(await ids({ limit: '1', offset: '1' })).toEqual(['c']);
    expect(await ids({ q: 'CHESS' })).toEqual(['b', 'a']);
    expect(await ids({ q: ' chess ' })).toEqual(['b', 'a']);
  });

  it('omits an origin whose last_ok_at is older than 3 days', async () => {
    const now = Date.now();
    await seed(ORIGIN, [validSpace({ id: 'fresh' })], now - 2 * DAY);
    await seed('https://stale.example.org', [validSpace({ id: 'stale' })], now - 4 * DAY);
    const body = (await readJson(await call(answering(() => jsonResponse(document())), get(feedUrl())))) as { spaces: { id: string }[] };
    expect(body.spaces.map((s) => s.id)).toEqual(['fresh']);
  });

  it('omits blocked origins and blocked spaces', async () => {
    const now = Date.now();
    await seed(ORIGIN, [validSpace({ id: 'a' }), validSpace({ id: 'b' })], now);
    await seed('https://blocked.example.org', [validSpace({ id: 'c' })], now);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO blocks (origin, space_id, reason, created_at) VALUES (?1, '*', 'spam', ?2)").bind('https://blocked.example.org', now),
      env.DB.prepare("INSERT INTO blocks (origin, space_id, reason, created_at) VALUES (?1, 'b', 'spam', ?2)").bind(ORIGIN, now),
    ]);
    const body = (await readJson(await call(answering(() => jsonResponse(document())), get(feedUrl())))) as { spaces: { id: string }[] };
    expect(body.spaces.map((s) => s.id)).toEqual(['a']);
  });

  it('is served from caches.default for a minute', async () => {
    const spy = answering(() => jsonResponse(document()));
    const url = feedUrl();
    const first = (await readJson(await call(spy, get(url)))) as { spaces: unknown[] };
    expect(first.spaces).toHaveLength(0);
    await seed(ORIGIN, [validSpace()], Date.now());
    // Same URL, so the cached answer is served and the new row is not seen yet.
    const second = (await readJson(await call(spy, get(url)))) as { spaces: unknown[] };
    expect(second.spaces).toHaveLength(0);
    // A different URL misses the cache and sees the row.
    const third = (await readJson(await call(spy, get(feedUrl())))) as { spaces: unknown[] };
    expect(third.spaces).toHaveLength(1);
  });

  it('answers 429 when the per-address limiter says no', async () => {
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await call(answering(() => jsonResponse(document())), get(feedUrl()), { ...env, RATE_LIMITER: limiter });
    expect(res.status).toBe(429);
  });
});

describe('other routes', () => {
  it('answers 404 elsewhere and to the wrong method on a known path', async () => {
    const spy = answering(() => jsonResponse(document()));
    expect((await call(spy, get(`${HUB}/`))).status).toBe(404);
    expect((await call(spy, get(`${HUB}/nope`))).status).toBe(404);
    expect((await call(spy, get(`${HUB}/v1/ping`))).status).toBe(404);
    expect((await call(spy, post('{}', `${HUB}/v1/spaces`))).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('scheduled', () => {
  it('deletes origins and fetch attempts older than 30 days and keeps the rest', async () => {
    const now = Date.now();
    await seed(ORIGIN, [validSpace({ id: 'keep' })], now - 29 * DAY);
    await seed('https://dead.example.org', [validSpace({ id: 'gone' })], now - 31 * DAY);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO fetch_attempts (origin, last_fetch_at) VALUES (?1, ?2)').bind(ORIGIN, now - 29 * DAY),
      env.DB.prepare('INSERT INTO fetch_attempts (origin, last_fetch_at) VALUES (?1, ?2)').bind('https://dead.example.org', now - 31 * DAY),
    ]);

    const ctx = createExecutionContext();
    await createWorker(answering(() => jsonResponse(document()))).scheduled(
      { scheduledTime: now, cron: '', noRetry() {} } as ScheduledController,
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect((await originRow(ORIGIN))?.origin).toBe(ORIGIN);
    expect(await originRow('https://dead.example.org')).toBeNull();
    expect(await spaceRows('https://dead.example.org')).toHaveLength(0);
    expect(await fetchAttempt(ORIGIN)).not.toBeNull();
    expect(await fetchAttempt('https://dead.example.org')).toBeNull();
  });
});
