import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'joiner';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    sendToSpace: vi.fn(),
    sendToUser: vi.fn(),
  },
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const OWNER_ID = 'owner';
const now = 1_700_000_000_000;

async function buildApp(): Promise<FastifyInstance> {
  const { spaceRoutes } = await import('./spaces.js');
  const { exploreRoutes } = await import('./explore.js');
  const f = Fastify();
  await f.register(spaceRoutes);
  await f.register(exploreRoutes);
  return f;
}

let app: FastifyInstance;

function makeSpace(id: string, visibility: 'public' | 'request' | 'private', inviteCode: string): void {
  testDb.insert(schema.spaces).values({
    id,
    name: `space-${visibility}`,
    ownerId: OWNER_ID,
    inviteCode,
    visibility,
    createdAt: now,
  }).run();
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'joiner';

  for (const id of [OWNER_ID, 'joiner', 'outsider']) {
    testDb.insert(schema.users).values({
      id, username: id, passwordHash: 'x', createdAt: now,
    }).run();
  }

  app = await buildApp();
});

function setVisibility(spaceId: string, visibility: 'public' | 'request' | 'private'): void {
  testDb.update(schema.spaces).set({ visibility }).where(eq(schema.spaces.id, spaceId)).run();
}

function addMember(spaceId: string, userId: string): void {
  testDb.insert(schema.spaceMembers).values({ spaceId, userId, joinedAt: now }).run();
}

function addJoinRequest(spaceId: string, userId: string, status: 'pending' | 'accepted' | 'declined'): void {
  testDb.insert(schema.joinRequests).values({
    id: `jr-${spaceId}-${userId}-${status}`,
    spaceId,
    userId,
    message: null,
    status,
    createdAt: now,
  }).run();
}

function pendingRequests(spaceId: string, userId: string): number {
  return testDb.select().from(schema.joinRequests).all()
    .filter(r => r.spaceId === spaceId && r.userId === userId && r.status === 'pending').length;
}

function isMember(spaceId: string, userId: string): boolean {
  return testDb.select().from(schema.spaceMembers).all()
    .some(m => m.spaceId === spaceId && m.userId === userId);
}

describe('POST /api/spaces/:id/join — visibility guard', () => {
  it('answers join_request_required with the space id for a request space, and admits no one', async () => {
    makeSpace('s-req', 'request', 'code-req');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/s-req/join',
      payload: { inviteCode: 'code-req' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('join_request_required');
    expect(res.json().details).toEqual({ spaceId: 's-req' });
    expect(isMember('s-req', 'joiner')).toBe(false);
    expect(pendingRequests('s-req', 'joiner')).toBe(0);
  });

  it('allows an invite-code join for a private space (invite is the only entry path)', async () => {
    makeSpace('s-priv', 'private', 'code-priv');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/s-priv/join',
      payload: { inviteCode: 'code-priv' },
    });
    expect(res.statusCode).toBe(200);
    expect(isMember('s-priv', 'joiner')).toBe(true);
  });

  it('allows an invite-code join for a public space', async () => {
    makeSpace('s-pub', 'public', 'code-pub');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/s-pub/join',
      payload: { inviteCode: 'code-pub' },
    });
    expect(res.statusCode).toBe(200);
    expect(isMember('s-pub', 'joiner')).toBe(true);
  });
});

describe('POST /api/spaces/join (codeless) — visibility guard', () => {
  it('answers join_request_required with the space id for a request space, and admits no one', async () => {
    makeSpace('s-req2', 'request', 'code-req2');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/join',
      payload: { inviteCode: 'code-req2' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('join_request_required');
    expect(res.json().details).toEqual({ spaceId: 's-req2' });
    expect(isMember('s-req2', 'joiner')).toBe(false);
  });

  it('allows an invite-code join for a private space', async () => {
    makeSpace('s-priv2', 'private', 'code-priv2');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/join',
      payload: { inviteCode: 'code-priv2' },
    });
    expect(res.statusCode).toBe(200);
    expect(isMember('s-priv2', 'joiner')).toBe(true);
  });
});

describe('POST /api/spaces/:id/invite — visibility guard', () => {
  // Caller is the owner (a member with CREATE_INVITE) so we exercise the
  // visibility guard, not the permission/membership gate.
  it('returns the invite code of a space joined by request', async () => {
    currentUserId = OWNER_ID;
    makeSpace('s-req-inv', 'request', 'code-req-inv');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s-req-inv/invite' });
    expect(res.statusCode).toBe(200);
    expect(res.json().inviteCode).toBe('code-req-inv');
  });

  it('mints a code for a request space that has none', async () => {
    currentUserId = OWNER_ID;
    testDb.insert(schema.spaces).values({
      id: 's-req-none', name: 'no code', ownerId: OWNER_ID, inviteCode: null, visibility: 'request', createdAt: now,
    }).run();
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s-req-none/invite' });
    expect(res.statusCode).toBe(200);
    const code = res.json().inviteCode as string;
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    const stored = testDb.select().from(schema.spaces).all().find(sp => sp.id === 's-req-none');
    expect(stored?.inviteCode).toBe(code);
  });

  it('still refuses a non-member, request space or not', async () => {
    currentUserId = 'outsider';
    makeSpace('s-req-out', 'request', 'code-req-out');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s-req-out/invite' });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_space_member');
  });

  it('returns an invite code for a private space', async () => {
    currentUserId = OWNER_ID;
    makeSpace('s-priv-inv', 'private', 'code-priv-inv');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s-priv-inv/invite' });
    expect(res.statusCode).toBe(200);
    expect(res.json().inviteCode).toBe('code-priv-inv');
  });

  it('returns an invite code for a public space', async () => {
    currentUserId = OWNER_ID;
    makeSpace('s-pub-inv', 'public', 'code-pub-inv');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s-pub-inv/invite' });
    expect(res.statusCode).toBe(200);
    expect(res.json().inviteCode).toBe('code-pub-inv');
  });
});

describe('GET /api/spaces/invite/:code/preview: visibility', () => {
  it('reports the visibility of each kind of space', async () => {
    makeSpace('p-req', 'request', 'pv-req');
    makeSpace('p-pub', 'public', 'pv-pub');
    makeSpace('p-priv', 'private', 'pv-priv');
    for (const [code, visibility, spaceId] of [
      ['pv-req', 'request', 'p-req'],
      ['pv-pub', 'public', 'p-pub'],
      ['pv-priv', 'private', 'p-priv'],
    ] as const) {
      const res = await app.inject({ method: 'GET', url: `/api/spaces/invite/${code}/preview` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ spaceId, visibility });
    }
  });

  it('answers invite_not_found for an unknown code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces/invite/nope/preview' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('invite_not_found');
  });
});

describe('an invite link to a request space', () => {
  const JOIN_URLS = [
    { name: 'POST /api/spaces/:id/join', url: '/api/spaces/s-link/join' },
    { name: 'POST /api/spaces/join', url: '/api/spaces/join' },
  ];

  beforeEach(() => {
    makeSpace('s-link', 'request', 'code-link');
    addMember('s-link', OWNER_ID);
  });

  for (const { name, url } of JOIN_URLS) {
    describe(name, () => {
      it('answers user_banned to a banned user, as every join path does', async () => {
        testDb.insert(schema.bans).values({ spaceId: 's-link', userId: 'joiner', bannedBy: OWNER_ID, createdAt: now }).run();
        const res = await app.inject({ method: 'POST', url, payload: { inviteCode: 'code-link' } });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('user_banned');
        expect(isMember('s-link', 'joiner')).toBe(false);
      });

      it('answers already_member to a member', async () => {
        addMember('s-link', 'joiner');
        const res = await app.inject({ method: 'POST', url, payload: { inviteCode: 'code-link' } });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('already_member');
      });

      it('answers join_request_pending to a user whose request is waiting', async () => {
        addJoinRequest('s-link', 'joiner', 'pending');
        const res = await app.inject({ method: 'POST', url, payload: { inviteCode: 'code-link' } });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('join_request_pending');
        expect(isMember('s-link', 'joiner')).toBe(false);
        expect(pendingRequests('s-link', 'joiner')).toBe(1);
      });

      it('answers join_request_required to a user whose earlier request was declined', async () => {
        addJoinRequest('s-link', 'joiner', 'declined');
        const res = await app.inject({ method: 'POST', url, payload: { inviteCode: 'code-link' } });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('join_request_required');
        expect(isMember('s-link', 'joiner')).toBe(false);
      });
    });
  }

  it('leads to a join request that a manager must approve', async () => {
    const preview = await app.inject({ method: 'GET', url: '/api/spaces/invite/code-link/preview' });
    expect(preview.json().visibility).toBe('request');

    const join = await app.inject({ method: 'POST', url: '/api/spaces/join', payload: { inviteCode: 'code-link' } });
    expect(join.json().code).toBe('join_request_required');
    const spaceId = join.json().details.spaceId as string;
    expect(spaceId).toBe(preview.json().spaceId);

    const sent = await app.inject({ method: 'POST', url: `/api/spaces/${spaceId}/request-join`, payload: { message: 'hi' } });
    expect(sent.statusCode).toBe(201);
    expect(isMember('s-link', 'joiner')).toBe(false);

    const again = await app.inject({ method: 'POST', url: '/api/spaces/join', payload: { inviteCode: 'code-link' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('join_request_pending');

    const requestAgain = await app.inject({ method: 'POST', url: `/api/spaces/${spaceId}/request-join`, payload: {} });
    expect(requestAgain.statusCode).toBe(409);
    expect(requestAgain.json().code).toBe('join_request_pending');

    currentUserId = OWNER_ID;
    const accepted = await app.inject({
      method: 'PATCH',
      url: `/api/spaces/${spaceId}/join-requests/${sent.json().id}`,
      payload: { action: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(isMember('s-link', 'joiner')).toBe(true);

    currentUserId = 'joiner';
    const afterAccept = await app.inject({ method: 'POST', url: '/api/spaces/join', payload: { inviteCode: 'code-link' } });
    expect(afterAccept.statusCode).toBe(409);
    expect(afterAccept.json().code).toBe('already_member');
  });
});

describe('an invite link after the space changes visibility', () => {
  it('follows a public space switched to request: no direct join, a request instead', async () => {
    makeSpace('s-vis1', 'public', 'code-vis1');
    setVisibility('s-vis1', 'request');

    const preview = await app.inject({ method: 'GET', url: '/api/spaces/invite/code-vis1/preview' });
    expect(preview.json().visibility).toBe('request');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/join', payload: { inviteCode: 'code-vis1' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('join_request_required');
    expect(isMember('s-vis1', 'joiner')).toBe(false);
  });

  it('follows a request space switched to private: the link admits, as a private invite does', async () => {
    makeSpace('s-vis2', 'request', 'code-vis2');
    setVisibility('s-vis2', 'private');

    const preview = await app.inject({ method: 'GET', url: '/api/spaces/invite/code-vis2/preview' });
    expect(preview.json().visibility).toBe('private');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/join', payload: { inviteCode: 'code-vis2' } });
    expect(res.statusCode).toBe(200);
    expect(isMember('s-vis2', 'joiner')).toBe(true);
  });

  it('follows a request space switched to public: the link admits, and a request is refused', async () => {
    makeSpace('s-vis3', 'request', 'code-vis3');
    setVisibility('s-vis3', 'public');

    const request = await app.inject({ method: 'POST', url: '/api/spaces/s-vis3/request-join', payload: {} });
    expect(request.statusCode).toBe(403);
    expect(request.json().code).toBe('space_not_requestable');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s-vis3/join', payload: { inviteCode: 'code-vis3' } });
    expect(res.statusCode).toBe(200);
    expect(isMember('s-vis3', 'joiner')).toBe(true);
  });
});
