import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { config } from '../config.js';
import { resetReleaseCacheForTest } from '../utils/releaseCheck.js';

// Auth is mocked rather than backed by a database: this route touches no
// tables, and the contract under test is the response shape and the admin gate,
// not JWT verification (covered in auth.test.ts).
let callerIsAdmin = true;

vi.mock('../utils/auth.js', () => ({
  authenticate: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) {
      return reply.code(401).send({ error: 'Missing or invalid authorization header', statusCode: 401 });
    }
    (request as FastifyRequest & { userId: string }).userId = 'user-1';
  },
  requireAdmin: async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!callerIsAdmin) {
      return reply.code(403).send({ error: 'Only instance admins can perform this action', statusCode: 403 });
    }
  },
}));

const mutableUpdates = config.updates as { checkEnabled: boolean; installChannel?: string };

let app: FastifyInstance;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function stubRelease(tag: string): void {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        tag_name: tag,
        html_url: `https://github.com/TheZwiss/backspace/releases/tag/${tag}`,
        published_at: '2026-09-03T11:00:00Z',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ) as unknown as Response,
  ) as unknown as ReturnType<typeof vi.spyOn>;
}

beforeEach(async () => {
  callerIsAdmin = true;
  mutableUpdates.checkEnabled = true;
  delete mutableUpdates.installChannel;
  resetReleaseCacheForTest();

  const { adminUpdateRoutes } = await import('./adminUpdates.js');
  app = Fastify();
  await app.register(adminUpdateRoutes);
});

afterEach(() => {
  fetchSpy?.mockRestore();
  resetReleaseCacheForTest();
  mutableUpdates.checkEnabled = true;
});

const AUTH = { authorization: 'Bearer token' };

describe('GET /api/admin/instance/update-status', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/instance/update-status' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a non-admin', async () => {
    callerIsAdmin = false;
    const res = await app.inject({
      method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH,
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns the full contract', async () => {
    stubRelease('v99.0.0');
    const res = await app.inject({
      method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toMatchObject({
      current: { version: config.version, commit: config.commit },
      latest: {
        version: '99.0.0',
        url: 'https://github.com/TheZwiss/backspace/releases/tag/v99.0.0',
        publishedAt: '2026-09-03T11:00:00Z',
      },
      state: 'update-available',
      checkEnabled: true,
      reason: null,
      channel: 'unknown',
    });
    expect(typeof body.checkedAt).toBe('number');
  });

  it('reports up to date when the latest release matches the running version', async () => {
    stubRelease(`v${config.version}`);
    const res = await app.inject({
      method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH,
    });
    expect(res.json().state).toBe('up-to-date');
    expect(res.json().latest.version).toBe(config.version);
  });

  it('reports the install channel when install.sh recorded one', async () => {
    stubRelease(`v${config.version}`);
    mutableUpdates.installChannel = 'prebuilt';
    let res = await app.inject({ method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH });
    expect(res.json().channel).toBe('prebuilt');

    mutableUpdates.installChannel = 'source';
    res = await app.inject({ method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH });
    expect(res.json().channel).toBe('source');
  });

  it('reports unknown for an unrecognised channel value rather than passing it through', async () => {
    stubRelease(`v${config.version}`);
    mutableUpdates.installChannel = 'somethingelse';
    const res = await app.inject({ method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH });
    expect(res.json().channel).toBe('unknown');
  });

  it('still serves the running version when the lookup is turned off', async () => {
    mutableUpdates.checkEnabled = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not be called')) as never;

    const res = await app.inject({
      method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      current: { version: config.version },
      latest: null,
      state: 'unknown',
      checkEnabled: false,
      reason: 'disabled',
      checkedAt: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still serves the running version when GitHub is unreachable', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('getaddrinfo ENOTFOUND')) as never;

    const res = await app.inject({
      method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      current: { version: config.version },
      latest: null,
      state: 'unknown',
      reason: 'unreachable',
      checkEnabled: true,
    });
  });

  it('serves a repeat request from cache without a second lookup', async () => {
    stubRelease('v99.0.0');
    await app.inject({ method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH });
    await app.inject({ method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('performs a fresh lookup for an explicit re-check', async () => {
    stubRelease('v99.0.0');
    await app.inject({ method: 'GET', url: '/api/admin/instance/update-status', headers: AUTH });
    await app.inject({
      method: 'GET', url: '/api/admin/instance/update-status?refresh=true', headers: AUTH,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not let refresh=true override the kill switch', async () => {
    mutableUpdates.checkEnabled = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not be called')) as never;

    const res = await app.inject({
      method: 'GET', url: '/api/admin/instance/update-status?refresh=true', headers: AUTH,
    });
    expect(res.json().reason).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exposes no way to trigger an update', async () => {
    // Applying a container update from inside the container needs the Docker
    // socket, which is host root. There is deliberately no POST here.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method, url: '/api/admin/instance/update-status', headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
