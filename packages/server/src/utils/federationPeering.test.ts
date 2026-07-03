import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';
import type { EnsurePeeredResult } from './federationPeering.js';
import { racePeering } from './federationPeering.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('./federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('./federationAuth.js')>('./federationAuth.js');
  return {
    ...actual,
    getOurOrigin: () => 'https://local.example',
    generateHmacSecret: () => 'mock-hmac-secret',
  };
});

vi.mock('../routes/federation.js', () => ({
  validateOrigin: (raw: string) => {
    try {
      const url = new URL(raw);
      return url.origin;
    } catch {
      return null;
    }
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    sendToUser: vi.fn(),
    getAllOnlineUserIds: () => [],
  },
}));

vi.mock('./federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(async () => undefined),
  onPeerDeactivated: vi.fn(async () => undefined),
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sqlText.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

describe('EnsurePeeredResult type', () => {
  it('active result has peerId', () => {
    const result: EnsurePeeredResult = {
      status: 'active',
      peerId: '123',
    };
    expect(result.status).toBe('active');
    if (result.status === 'active') {
      expect(result.peerId).toBe('123');
    }
  });

  it('rejected result has error', () => {
    const result: EnsurePeeredResult = {
      status: 'rejected',
      error: 'Remote instance requires manual peering approval',
    };
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toContain('manual peering');
    }
  });

  it('failed result has error', () => {
    const result: EnsurePeeredResult = {
      status: 'failed',
      error: 'timeout',
    };
    expect(result.status).toBe('failed');
  });

  it('pending result has error', () => {
    const result: EnsurePeeredResult = {
      status: 'pending',
      error: 'Awaiting admin approval on remote instance',
    };
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.error).toContain('admin approval');
    }
  });
});

describe('racePeering', () => {
  it('returns the ensurePeered result when it resolves before the timeout', async () => {
    const stub = vi.fn(async (): Promise<EnsurePeeredResult> => ({
      status: 'active',
      peerId: 'peer-1',
    }));
    const result = await racePeering('https://example.com', 1_000, { kind: 'system' }, stub);
    expect(result).toEqual({ status: 'active', peerId: 'peer-1' });
    expect(stub).toHaveBeenCalledWith('https://example.com', { kind: 'system' });
  });

  it('returns timeout when ensurePeered takes longer than the deadline', async () => {
    vi.useFakeTimers();
    const stub = vi.fn((): Promise<EnsurePeeredResult> => new Promise(() => {
      // Never resolves — simulates a slow handshake.
    }));
    const racePromise = racePeering('https://example.com', 50, { kind: 'system' }, stub);
    await vi.advanceTimersByTimeAsync(50);
    const result = await racePromise;
    expect(result).toEqual({ status: 'timeout' });
    vi.useRealTimers();
  });

  it('returns rejected result verbatim when ensurePeered resolves with rejection', async () => {
    const stub = vi.fn(async (): Promise<EnsurePeeredResult> => ({
      status: 'rejected',
      error: 'peer denied',
    }));
    const result = await racePeering('https://example.com', 1_000, { kind: 'system' }, stub);
    expect(result).toEqual({ status: 'rejected', error: 'peer denied' });
  });

  it('attaches a warn-logged catch to the background handshake when the timeout wins', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = vi.fn(() => new Promise<EnsurePeeredResult>((_, reject) => {
      setTimeout(() => reject(new Error('late failure')), 30);
    }));
    const racePromise = racePeering('https://example.com', 10, { kind: 'system' }, stub);
    await vi.advanceTimersByTimeAsync(10);
    const result = await racePromise;
    expect(result).toEqual({ status: 'timeout' });
    await vi.advanceTimersByTimeAsync(30);
    // Let microtasks flush so the .catch handler runs.
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('background handshake'),
      'https://example.com',
      expect.any(Error),
    );
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('normalizes a thrown handshake error into { status: failed } without emitting the background warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = vi.fn(async (): Promise<EnsurePeeredResult> => {
      throw new Error('immediate handshake failure');
    });
    const result = await racePeering('https://example.com', 1_000, { kind: 'system' }, stub);
    expect(result).toEqual({ status: 'failed', error: 'immediate handshake failure' });
    // The handshake rejection was the race winner — no background warn should fire.
    await Promise.resolve();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('ensurePeered needs_attention handling', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    const { _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('returns rejected without calling performHandshake when peer is in needs_attention', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-na',
      origin: 'https://remote.example',
      status: 'needs_attention',
      hmacSecret: 'secret',
      createdAt: Date.now(),
      lastSyncedAt: 0,
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://remote.example', { kind: 'system' });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toContain('needs_attention');
    }
    // performHandshake must not have fired — no POST to /peer/accept
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
