import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { ensureDefaults } from '../db/migrate.js';
import { setWorkerId } from '../utils/snowflake.js';
import { buildDirectoryDocument, absoluteAssetUrl } from './document.js';

setWorkerId(2);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The Explore route is mounted against the same in-memory database so the
// member-count comparison runs the real query, not a copy of it.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const EXPLORE_CALLER = 'u1';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = EXPLORE_CALLER;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    addUserSpace: vi.fn(),
  },
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const ORIGIN = 'https://home.test';
const CTX = { origin: ORIGIN, version: '1.4.0' };

interface SeedSpace {
  id: string;
  name?: string;
  visibility: 'public' | 'request' | 'private';
  listed: 0 | 1;
  members: string[];
  icon?: string | null;
  description?: string | null;
  createdAt?: number;
}

function seedSpace(s: SeedSpace): void {
  sqlite.prepare(
    `INSERT INTO spaces (id, name, icon, banner, avatar_color, owner_id, invite_code, visibility, directory_listed, description, created_at)
     VALUES (?, ?, ?, NULL, 'mint', 'u1', ?, ?, ?, ?, ?)`,
  ).run(
    s.id,
    s.name ?? `Space ${s.id}`,
    s.icon ?? null,
    `inv-${s.id}`,
    s.visibility,
    s.listed,
    s.description ?? null,
    s.createdAt ?? 1_700_000_000_000,
  );
  for (const userId of s.members) {
    sqlite.prepare('INSERT INTO space_members (space_id, user_id, joined_at) VALUES (?, ?, ?)').run(s.id, userId, 1_700_000_000_000);
  }
}

function seedBaseline(): void {
  for (const id of ['u1', 'u2']) {
    sqlite.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)").run(id, id, 1_700_000_000_000);
  }
  seedSpace({ id: 'A', visibility: 'public', listed: 1, members: ['u1', 'u2'], createdAt: 1_700_000_000_000 });
  seedSpace({ id: 'B', visibility: 'request', listed: 1, members: ['u1'], createdAt: 1_700_000_000_001 });
  seedSpace({ id: 'C', visibility: 'public', listed: 0, members: ['u1'] });
  seedSpace({ id: 'D', visibility: 'private', listed: 1, members: ['u1', 'u2'] });
  sqlite.prepare(
    `UPDATE instance_settings SET instance_name = 'Example', federated_registration_open = 1, discovery_enabled = 1, directory_enabled = 1 WHERE id = 1`,
  ).run();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  ensureDefaults(sqlite);
  testDb = drizzle(sqlite, { schema });
  seedBaseline();
});

describe('buildDirectoryDocument', () => {
  it('serves the envelope and the listed discoverable spaces, most members first', () => {
    const doc = buildDirectoryDocument(sqlite, CTX);
    expect(doc).toEqual({
      schema: 1,
      origin: ORIGIN,
      instance: { name: 'Example', federatedRegistrationOpen: true, version: '1.4.0' },
      spaces: [
        {
          id: 'A',
          name: 'Space A',
          description: null,
          icon: null,
          banner: null,
          avatarColor: 'mint',
          visibility: 'public',
          memberCount: 2,
          createdAt: 1_700_000_000_000,
        },
        {
          id: 'B',
          name: 'Space B',
          description: null,
          icon: null,
          banner: null,
          avatarColor: 'mint',
          visibility: 'request',
          memberCount: 1,
          createdAt: 1_700_000_000_001,
        },
      ],
    });
  });

  it('reports the same member counts as GET /api/spaces/explore for the same data', async () => {
    const app = Fastify({ logger: false });
    const { exploreRoutes } = await import('../routes/explore.js');
    await app.register(exploreRoutes);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/spaces/explore' });
    await app.close();
    expect(res.statusCode).toBe(200);
    const explore = JSON.parse(res.body) as { spaces: { id: string; memberCount: number }[] };
    const exploreCounts = new Map(explore.spaces.map((s) => [s.id, s.memberCount]));
    expect(exploreCounts.size).toBe(3);

    const doc = buildDirectoryDocument(sqlite, CTX);
    expect(doc.spaces.length).toBe(2);
    for (const space of doc.spaces) {
      expect(exploreCounts.get(space.id)).toBe(space.memberCount);
    }
  });

  it('turns stored icons into absolute URLs on this origin, and drops foreign ones', () => {
    sqlite.prepare("UPDATE spaces SET directory_listed = 0 WHERE id IN ('A', 'B')").run();
    seedSpace({ id: 'bare', visibility: 'public', listed: 1, members: [], icon: 'x.png' });
    seedSpace({ id: 'rooted', visibility: 'public', listed: 1, members: [], icon: '/api/uploads/x.png' });
    seedSpace({ id: 'absolute', visibility: 'public', listed: 1, members: [], icon: `${ORIGIN}/api/uploads/x.png` });
    seedSpace({ id: 'foreign', visibility: 'public', listed: 1, members: [], icon: 'https://other.test/x.png' });

    const doc = buildDirectoryDocument(sqlite, CTX);
    const icons = new Map(doc.spaces.map((s) => [s.id, s.icon]));
    expect(icons.get('bare')).toBe(`${ORIGIN}/api/uploads/x.png`);
    expect(icons.get('rooted')).toBe(`${ORIGIN}/api/uploads/x.png`);
    expect(icons.get('absolute')).toBe(`${ORIGIN}/api/uploads/x.png`);
    expect(icons.get('foreign')).toBeNull();
    expect(doc.spaces.length).toBe(4);
  });

  it('serves an empty list with the envelope intact when the directory is off', () => {
    sqlite.prepare('UPDATE instance_settings SET directory_enabled = 0 WHERE id = 1').run();
    const doc = buildDirectoryDocument(sqlite, CTX);
    expect(doc).toEqual({
      schema: 1,
      origin: ORIGIN,
      instance: { name: 'Example', federatedRegistrationOpen: true, version: '1.4.0' },
      spaces: [],
    });
  });

  it('serves an empty list with the envelope intact when discovery is off', () => {
    sqlite.prepare('UPDATE instance_settings SET discovery_enabled = 0 WHERE id = 1').run();
    const doc = buildDirectoryDocument(sqlite, CTX);
    expect(doc).toEqual({
      schema: 1,
      origin: ORIGIN,
      instance: { name: 'Example', federatedRegistrationOpen: true, version: '1.4.0' },
      spaces: [],
    });
  });

  it('cuts a long description to 200 characters and a long name to 100', () => {
    sqlite.prepare("UPDATE spaces SET name = ?, description = ? WHERE id = 'A'").run('n'.repeat(150), 'd'.repeat(300));
    const doc = buildDirectoryDocument(sqlite, CTX);
    const a = doc.spaces.find((s) => s.id === 'A');
    expect(a?.name).toBe('n'.repeat(100));
    expect(a?.description).toBe('d'.repeat(200));
  });

  it('serves at most 200 spaces', () => {
    for (let i = 0; i < 250; i += 1) {
      seedSpace({ id: `bulk-${i}`, visibility: 'public', listed: 1, members: [] });
    }
    const doc = buildDirectoryDocument(sqlite, CTX);
    expect(doc.spaces.length).toBe(200);
  });
});

describe('absoluteAssetUrl', () => {
  it('follows the one asset rule', () => {
    expect(absoluteAssetUrl(null, ORIGIN)).toBeNull();
    expect(absoluteAssetUrl(`${ORIGIN}/api/uploads/x.png`, ORIGIN)).toBe(`${ORIGIN}/api/uploads/x.png`);
    expect(absoluteAssetUrl('https://other.test/x.png', ORIGIN)).toBeNull();
    expect(absoluteAssetUrl('http://other.test/x.png', ORIGIN)).toBeNull();
    expect(absoluteAssetUrl('https://home.test.evil/x.png', ORIGIN)).toBeNull();
    expect(absoluteAssetUrl('/api/uploads/x.png', ORIGIN)).toBe(`${ORIGIN}/api/uploads/x.png`);
    expect(absoluteAssetUrl('x.png', ORIGIN)).toBe(`${ORIGIN}/api/uploads/x.png`);
  });
});
