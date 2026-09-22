import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type LightMyRequestResponse,
  type RouteOptions,
} from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DirectoryEntry } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { ensureDefaults } from '../db/migrate.js';
import { setWorkerId } from '../utils/snowflake.js';
import * as documentModule from '../directory/document.js';
import { markDirectoryDirty, _resetDirectoryStateForTests } from '../directory/state.js';

setWorkerId(5);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('./federation/origin.js', () => ({
  resolveLocalOrigin: () => 'https://home.test',
}));

// Mutable so the proxy tests can switch the endpoint off; beforeEach puts it back.
const mockConfig = vi.hoisted(() => ({ version: '1.4.0', directory: { endpoint: 'https://hub.test' } }));

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) {
      return reply.code(401).send({ error: 'Missing or invalid authorization header', code: 'unauthorized', statusCode: 401 });
    }
    (request as FastifyRequest & { userId: string }).userId = 'u1';
  },
}));

// Passthrough mock so the builder export lives on a plain object vi.spyOn can wrap.
vi.mock('../directory/document.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../directory/document.js')>();
  return { ...actual };
});

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

/** Route config captured by an onRoute hook; the test app has no @fastify/rate-limit. */
let capturedRoutes: Array<Pick<RouteOptions, 'method' | 'url' | 'config'>> = [];

async function buildApp(): Promise<FastifyInstance> {
  const { directoryRoutes, _resetDirectoryRouteCacheForTests, _resetDirectoryProxyForTests } = await import('./directory.js');
  _resetDirectoryRouteCacheForTests();
  _resetDirectoryProxyForTests();
  capturedRoutes = [];
  const f = Fastify({ logger: false });
  f.addHook('onRoute', (routeOptions) => {
    capturedRoutes.push({ method: routeOptions.method, url: routeOptions.url, config: routeOptions.config });
  });
  await f.register(directoryRoutes);
  await f.ready();
  return f;
}

const T0 = new Date('2026-09-22T12:00:00Z').getTime();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mockConfig.directory.endpoint = 'https://hub.test';
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  ensureDefaults(sqlite);
  testDb = drizzle(sqlite, { schema });
  _resetDirectoryStateForTests();

  sqlite.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1', 'u1', 'x', 1)").run();
  sqlite.prepare(
    `INSERT INTO spaces (id, name, owner_id, invite_code, visibility, directory_listed, created_at)
     VALUES ('A', 'Space A', 'u1', 'inv-A', 'public', 1, 1)`,
  ).run();
  sqlite.prepare("INSERT INTO space_members (space_id, user_id, joined_at) VALUES ('A', 'u1', 1)").run();
  sqlite.prepare(
    "UPDATE instance_settings SET instance_name = 'Example', discovery_enabled = 1, directory_enabled = 1 WHERE id = 1",
  ).run();

  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GET /api/directory/spaces', () => {
  it('serves the document without authentication and forbids intermediaries from serving it stale', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(JSON.parse(res.body)).toEqual({
      schema: 1,
      origin: 'https://home.test',
      instance: { name: 'Example', federatedRegistrationOpen: true, version: '1.4.0' },
      spaces: [
        {
          id: 'A',
          name: 'Space A',
          description: null,
          icon: null,
          banner: null,
          avatarColor: null,
          visibility: 'public',
          memberCount: 1,
          createdAt: 1,
        },
      ],
    });
  });

  it('builds once for two requests inside 30 s', async () => {
    const spy = vi.spyOn(documentModule, 'buildDirectoryDocument');
    await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    vi.setSystemTime(T0 + 29_000);
    const second = await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    expect(second.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds on the next request after markDirectoryDirty', async () => {
    const spy = vi.spyOn(documentModule, 'buildDirectoryDocument');
    await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    sqlite.prepare("UPDATE spaces SET directory_listed = 0 WHERE id = 'A'").run();
    markDirectoryDirty(sqlite);
    const res = await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body).spaces).toEqual([]);
  });

  it('rebuilds on the next request once 30 s have passed', async () => {
    const spy = vi.spyOn(documentModule, 'buildDirectoryDocument');
    await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    vi.setSystemTime(T0 + 30_000);
    await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

const ENTRY: DirectoryEntry = {
  id: 'A',
  name: 'Space A',
  description: null,
  icon: null,
  banner: null,
  avatarColor: null,
  visibility: 'public',
  memberCount: 1,
  createdAt: 1,
  origin: 'https://other.test',
  instanceName: 'Other',
  federatedRegistrationOpen: true,
};

type FetchMock = ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

function feedResponse(spaces: DirectoryEntry[] = [ENTRY], extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ schema: 1, spaces }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/** Stubs global fetch with a hub that answers every request with the same feed. */
function stubHub(respond: () => Promise<Response> = async () => feedResponse()): FetchMock {
  const fetchMock: FetchMock = vi.fn(async () => respond());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function calledUrl(fetchMock: FetchMock, index: number): string {
  const input = fetchMock.mock.calls[index]?.[0];
  if (input === undefined) throw new Error(`fetch call ${index} did not happen`);
  return input instanceof Request ? input.url : String(input);
}

function calledInit(fetchMock: FetchMock, index: number): RequestInit {
  const init = fetchMock.mock.calls[index]?.[1];
  if (init === undefined) throw new Error(`fetch call ${index} had no init`);
  return init;
}

const AUTH = { authorization: 'Bearer token' };

function proxy(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: AUTH });
}

/** Lets the injected requests reach their handlers without a real sleep. */
async function flushMacrotasks(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('GET /api/directory', () => {
  it('requires authentication', async () => {
    const fetchMock = stubHub();
    const res = await app.inject({ method: 'GET', url: '/api/directory' });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 404 directory_disabled when the endpoint is empty, without calling upstream', async () => {
    mockConfig.directory.endpoint = '';
    const fetchMock = stubHub();
    const res = await proxy('/api/directory?q=x');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('directory_disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards validated params to the hub and returns its feed', async () => {
    const fetchMock = stubHub();
    const res = await proxy('/api/directory?q=%20chess%20&limit=20&offset=40');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ schema: 1, spaces: [ENTRY] });
    expect(calledUrl(fetchMock, 0)).toBe('https://hub.test/v1/spaces?q=chess&limit=20&offset=40');
    const init = calledInit(fetchMock, 0);
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('applies the defaults when no params are given', async () => {
    const fetchMock = stubHub();
    const res = await proxy('/api/directory');
    expect(res.statusCode).toBe(200);
    expect(calledUrl(fetchMock, 0)).toBe('https://hub.test/v1/spaces?limit=50&offset=0');
  });

  it('clamps out-of-range params instead of rejecting them', async () => {
    const fetchMock = stubHub();
    const longQuery = 'a'.repeat(150);
    await proxy(`/api/directory?q=${longQuery}&limit=500&offset=5000`);
    expect(calledUrl(fetchMock, 0)).toBe(`https://hub.test/v1/spaces?q=${'a'.repeat(100)}&limit=100&offset=1000`);
    await proxy('/api/directory?limit=0&offset=-5');
    expect(calledUrl(fetchMock, 1)).toBe('https://hub.test/v1/spaces?limit=1&offset=0');
    await proxy('/api/directory?limit=abc&offset=abc');
    expect(calledUrl(fetchMock, 2)).toBe('https://hub.test/v1/spaces?limit=50&offset=0');
  });

  it('serves a cached feed for the same query inside 60 s', async () => {
    const fetchMock = stubHub();
    await proxy('/api/directory?q=chess');
    vi.setSystemTime(T0 + 59_000);
    const second = await proxy('/api/directory?q=chess');
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ schema: 1, spaces: [ENTRY] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches again once 60 s have passed', async () => {
    const fetchMock = stubHub();
    await proxy('/api/directory?q=chess');
    vi.setSystemTime(T0 + 60_000);
    await proxy('/api/directory?q=chess');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The hub caches the feed at its edge for 60 s and says how old its copy
  // is in `Age`; the proxy's own 60 s counts from when the edge copy was
  // made, so freshness is bounded at 60 s end to end.
  it('expires an answer with Age: 50 after 10 s, not 60', async () => {
    const fetchMock = stubHub(async () => feedResponse([ENTRY], { age: '50' }));
    await proxy('/api/directory?q=chess');
    vi.setSystemTime(T0 + 9_000);
    await proxy('/api/directory?q=chess');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 10_000);
    await proxy('/api/directory?q=chess');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the full 60 s when the answer carries no Age', async () => {
    const fetchMock = stubHub();
    await proxy('/api/directory?q=chess');
    vi.setSystemTime(T0 + 59_000);
    await proxy('/api/directory?q=chess');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the full 60 s when the Age header is not a number', async () => {
    const fetchMock = stubHub(async () => feedResponse([ENTRY], { age: 'soon' }));
    await proxy('/api/directory?q=chess');
    vi.setSystemTime(T0 + 59_000);
    await proxy('/api/directory?q=chess');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clamps an Age beyond the TTL so the entry expires on the next request without throwing', async () => {
    const fetchMock = stubHub(async () => feedResponse([ENTRY], { age: '500' }));
    const first = await proxy('/api/directory?q=chess');
    expect(first.statusCode).toBe(200);
    const second = await proxy('/api/directory?q=chess');
    expect(second.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a different q as a cache miss', async () => {
    const fetchMock = stubHub();
    await proxy('/api/directory?q=chess');
    await proxy('/api/directory?q=go');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keys the cache on the exact limit and offset too', async () => {
    const fetchMock = stubHub();
    await proxy('/api/directory?q=chess&limit=10');
    await proxy('/api/directory?q=chess&limit=20');
    await proxy('/api/directory?q=chess&limit=20&offset=20');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('evicts the first entry when the 65th distinct query arrives', async () => {
    const fetchMock = stubHub();
    for (let i = 0; i < 65; i += 1) {
      await proxy(`/api/directory?q=q${i}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(65);
    await proxy('/api/directory?q=q1');
    expect(fetchMock).toHaveBeenCalledTimes(65);
    await proxy('/api/directory?q=q0');
    expect(fetchMock).toHaveBeenCalledTimes(66);
  });

  it('coalesces two concurrent identical requests into one upstream fetch', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = stubHub(async () => {
      await gate;
      return feedResponse();
    });
    const first = proxy('/api/directory?q=chess');
    const second = proxy('/api/directory?q=chess');
    await flushMacrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (release === null) throw new Error('gate was not armed');
    (release as () => void)();
    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(JSON.parse(b.body)).toEqual(JSON.parse(a.body));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps an upstream 500 to 502 directory_unreachable', async () => {
    stubHub(async () => new Response('nope', { status: 500 }));
    const res = await proxy('/api/directory?q=chess');
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('directory_unreachable');
  });

  it('maps an upstream body that is not a feed to 502 directory_unreachable', async () => {
    stubHub(async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }));
    const res = await proxy('/api/directory?q=chess');
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('directory_unreachable');
  });

  it('maps an upstream body that is not JSON to 502 directory_unreachable', async () => {
    stubHub(async () => new Response('<html>', { status: 200 }));
    const res = await proxy('/api/directory?q=chess');
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('directory_unreachable');
  });

  it('maps a rejected fetch to 502 directory_unreachable', async () => {
    stubHub(async () => { throw new Error('ECONNREFUSED'); });
    const res = await proxy('/api/directory?q=chess');
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('directory_unreachable');
  });

  it('does not cache a failure', async () => {
    let calls = 0;
    const fetchMock = stubHub(async () => {
      calls += 1;
      return calls === 1 ? new Response('nope', { status: 500 }) : feedResponse();
    });
    const failed = await proxy('/api/directory?q=chess');
    expect(failed.statusCode).toBe(502);
    const recovered = await proxy('/api/directory?q=chess');
    expect(recovered.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('carries its own limiter of 30 per minute', () => {
    const route = capturedRoutes.find((r) => r.url === '/api/directory' && r.method === 'GET');
    expect(route).toBeDefined();
    expect(route?.config).toEqual({ rateLimit: { max: 30, timeWindow: '1 minute' } });
  });
});
