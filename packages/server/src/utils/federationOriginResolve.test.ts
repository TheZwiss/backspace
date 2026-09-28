import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let mockOurOrigin = 'https://home.test';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('./federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('./federationAuth.js')>();
  return { ...actual, getOurOrigin: () => mockOurOrigin };
});

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedPeer(origin: string, status = 'active'): void {
  testDb.insert(schema.federationPeers).values({
    id: `peer-${origin}`,
    origin,
    hmacSecret: 'a'.repeat(64),
    status,
    nonceSupported: 1,
    createdAt: Date.now(),
    consecutiveFailures: 0,
    consecutiveAuthFailures: 0,
  } as typeof schema.federationPeers.$inferInsert).run();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  mockOurOrigin = 'https://home.test';
});

describe('resolveOriginFromHostname', () => {
  it('returns stored peer origin on exact host match', async () => {
    seedPeer('https://orbit.test');
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('orbit.test')).toBe('https://orbit.test');
  });

  it('matches peer origin case-insensitively', async () => {
    seedPeer('https://orbit.test');
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('ORBIT.TEST')).toBe('https://orbit.test');
  });

  it('mirrors https scheme when no peer matches', async () => {
    mockOurOrigin = 'https://home.test';
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('newpeer.example')).toBe('https://newpeer.example');
  });

  it('mirrors http scheme for localhost targets', async () => {
    mockOurOrigin = 'http://localhost:3005';
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('localhost:3006')).toBe('http://localhost:3006');
  });

  it('returns null when validateOrigin rejects http for non-localhost', async () => {
    mockOurOrigin = 'http://localhost:3005';
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('newpeer.example')).toBeNull();
  });

  it('returns null for empty input', async () => {
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('')).toBeNull();
  });

  // A stored identity carries the bare hostname: extractDomain drops the port.
  // The peer row is keyed by the origin the instance advertises, port included.
  it('maps a bare identity hostname to the one peer on that host with a port', async () => {
    seedPeer('https://orbit.test:1443');
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('orbit.test')).toBe('https://orbit.test:1443');
  });

  it('maps a bare identity hostname to an http peer origin with a port (PUBLIC_ORIGIN)', async () => {
    seedPeer('http://orbit.test:8080');
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('orbit.test')).toBe('http://orbit.test:8080');
  });

  it('prefers the peer on the default port when the hostname has one', async () => {
    seedPeer('https://orbit.test:1443');
    seedPeer('https://orbit.test');
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('orbit.test')).toBe('https://orbit.test');
  });

  it('does not guess between two ported peers on one hostname', async () => {
    seedPeer('https://orbit.test:1443');
    seedPeer('https://orbit.test:2443');
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('orbit.test')).toBe('https://orbit.test');
  });

  it('a host with a port matches only that port', async () => {
    seedPeer('https://orbit.test:1443');
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('orbit.test:2443')).toBe('https://orbit.test:2443');
  });

  it.each(['unreachable', 'needs_attention', 'rejected', 'pending'])(
    'a lone ported row that is %s does not capture the bare host: it gets the default-port origin',
    async (status) => {
      seedPeer('http://orbit.test:8080', status);
      const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
      expect(resolveOriginFromHostname('orbit.test')).toBe('https://orbit.test');
    },
  );

  it('an active ported row is used even when a dead ported row shares the hostname', async () => {
    seedPeer('http://orbit.test:8080', 'unreachable');
    seedPeer('https://orbit.test:1443');
    const { resolveOriginFromHostname } = await import('./federationOriginResolve.js');
    expect(resolveOriginFromHostname('orbit.test')).toBe('https://orbit.test:1443');
  });
});
