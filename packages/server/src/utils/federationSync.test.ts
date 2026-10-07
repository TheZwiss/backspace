import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import type { FederationRelayEvent, FederationSyncRequest } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('./federationOutbox.js', () => ({
  isFederationRelayEnabled: () => true,
}));

vi.mock('./federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('./federationAuth.js')>();
  return {
    ...actual,
    getOurOrigin: () => 'https://local.example',
    buildFederationHeaders: (_body: string, _secret: string, origin: string) => ({
      'Content-Type': 'application/json',
      'X-Federation-Origin': origin,
    }),
  };
});

type ProcessResult = { accepted: string[]; rejected: Array<{ messageId: string; reason: string }>; undeliverable: [] };
const processRelayEvents = vi.fn<(events: FederationRelayEvent[]) => Promise<ProcessResult>>();

vi.mock('../routes/federation.js', () => ({
  processRelayEvents: (events: FederationRelayEvent[]) => processRelayEvents(events),
}));

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

const PEER = 'peer-1';
const PEER_ORIGIN = 'https://peer-1.example';

function seedPeer(overrides: Partial<typeof schema.federationPeers.$inferInsert> = {}): void {
  testDb.insert(schema.federationPeers).values({
    id: PEER, origin: PEER_ORIGIN, hmacSecret: 'secret', status: 'active',
    lastSyncedAt: 0, createdAt: 1, ...overrides,
  }).run();
}

function event(messageId: string, timestamp: number, dmChannelId = 'ch-1'): FederationRelayEvent {
  return { eventType: 'create', dmChannelId, messageId, encryptionVersion: 0, timestamp };
}

interface Page {
  events?: FederationRelayEvent[];
  hasMore?: boolean;
  checkpoint: number;
  checkpointId?: string;
}

/** Answer each /sync request with the next page for its context; empty once they run out. */
function serve(pages: Partial<Record<'dm' | 'friend' | 'profile', Page[]>>): FederationSyncRequest[] {
  const requests: FederationSyncRequest[] = [];
  const remaining = {
    dm: [...(pages.dm ?? [])],
    friend: [...(pages.friend ?? [])],
    profile: [...(pages.profile ?? [])],
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as FederationSyncRequest;
    requests.push(body);
    const context = body.contextType ?? 'dm';
    const page = remaining[context].shift() ?? { checkpoint: body.sinceTimestamp };
    return new Response(JSON.stringify({
      events: page.events ?? [],
      hasMore: page.hasMore ?? false,
      checkpoint: page.checkpoint,
      ...(page.checkpointId !== undefined ? { checkpointId: page.checkpointId } : {}),
    }), { status: 200 });
  });
  return requests;
}

function cursor(context: string): { cursorTs: number; cursorId: string | null } | undefined {
  return testDb.select({ cursorTs: schema.federationSyncCursors.cursorTs, cursorId: schema.federationSyncCursors.cursorId })
    .from(schema.federationSyncCursors)
    .where(and(eq(schema.federationSyncCursors.peerId, PEER), eq(schema.federationSyncCursors.contextType, context)))
    .get();
}

function keptEvents(): Array<{ messageId: string; lastReason: string; attempts: number }> {
  return testDb.select({
    messageId: schema.federationSyncRetry.messageId,
    lastReason: schema.federationSyncRetry.lastReason,
    attempts: schema.federationSyncRetry.attempts,
  })
    .from(schema.federationSyncRetry)
    .orderBy(schema.federationSyncRetry.eventTs)
    .all();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  processRelayEvents.mockReset();
  processRelayEvents.mockImplementation(async (events) => ({ accepted: events.map(e => e.messageId), rejected: [], undeliverable: [] }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncPeerMutationLog: cursors', () => {
  it('keeps the cursor in the peer clock and starts the next pass an overlap before it', async () => {
    const { syncPeerMutationLog, FIRST_PAGE_OVERLAP_MS } = await import('./federationSync.js');
    seedPeer();
    // The peer's log is 10 minutes into its clock; local time is far later.
    const peerNow = 600_000;
    let requests = serve({ dm: [{ events: [event('m1', peerNow)], checkpoint: peerNow, checkpointId: 'row-9' }] });
    await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    expect(requests[0]).toMatchObject({ sinceTimestamp: 0, contextType: 'dm' });
    expect(cursor('dm')).toEqual({ cursorTs: peerNow, cursorId: 'row-9' });

    vi.restoreAllMocks();
    requests = serve({});
    await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    expect(requests[0]).toMatchObject({ sinceTimestamp: peerNow - FIRST_PAGE_OVERLAP_MS });
    expect(requests[0]!.afterId).toBeUndefined();
    // An empty page never moves the cursor back.
    expect(cursor('dm')).toEqual({ cursorTs: peerNow, cursorId: 'row-9' });
  });

  it('continues by keyset when the server returns checkpointId', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer();
    const requests = serve({
      dm: [
        { events: [event('m1', 500)], hasMore: true, checkpoint: 500, checkpointId: 'row-1' },
        { events: [event('m2', 500)], hasMore: false, checkpoint: 500, checkpointId: 'row-2' },
      ],
    });
    await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    expect(requests[1]).toMatchObject({ sinceTimestamp: 500, afterId: 'row-1' });
    expect(cursor('dm')).toEqual({ cursorTs: 500, cursorId: 'row-2' });
    expect(processRelayEvents).toHaveBeenCalledTimes(2);
  });

  it('against an older server, re-reads the checkpoint millisecond instead of skipping it', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer();
    const requests = serve({
      dm: [
        { events: [event('m1', 400), event('m2', 500)], hasMore: true, checkpoint: 500 },
        { events: [event('m2', 500), event('m3', 500)], hasMore: false, checkpoint: 500 },
      ],
    });
    await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    expect(requests[1]).toMatchObject({ sinceTimestamp: 499 });
    expect(requests[1]!.afterId).toBeUndefined();
  });

  it('a full page within one millisecond on an older server ends instead of looping', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tie: Page = { events: [event('m1', 500)], hasMore: true, checkpoint: 500 };
    const requests = serve({ dm: [tie, tie, tie, tie, { checkpoint: 500 }] });
    const result = await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    expect(result?.contexts.dm).toBe('ok');
    expect(requests.length).toBeLessThanOrEqual(4);
    expect(warn.mock.calls.some(c => String(c[0]).includes('cannot page within it'))).toBe(true);
  });

  it('restarts the cursors and drops kept events when the peer is a new incarnation', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer({ peerInstanceId: 'epoch-a' });
    serve({ dm: [{ events: [event('m1', 900)], checkpoint: 900, checkpointId: 'r' }] });
    await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    expect(cursor('dm')?.cursorTs).toBe(900);

    testDb.update(schema.federationPeers).set({ peerInstanceId: 'epoch-b' }).where(eq(schema.federationPeers.id, PEER)).run();
    vi.restoreAllMocks();
    const requests = serve({});
    await syncPeerMutationLog(PEER, 'initiate_accepted', ['dm']);
    expect(requests[0]!.sinceTimestamp).toBe(0);
  });

  it('pulls every context by default and sets last_synced_at only when all completed', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer({ lastSyncedAt: 42 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as FederationSyncRequest;
      if (body.contextType === 'friend') return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ events: [], hasMore: false, checkpoint: 0 }), { status: 200 });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await syncPeerMutationLog(PEER, 'health_check_recovery');
    expect(result?.contexts).toEqual({ dm: 'ok', friend: 'http_error', profile: 'ok' });
    const peer = testDb.select().from(schema.federationPeers).where(eq(schema.federationPeers.id, PEER)).get();
    expect(peer?.lastSyncedAt).toBe(42);
    // A refused pull does not touch peer state.
    expect(peer?.status).toBe('active');
    expect(peer?.consecutiveAuthFailures).toBe(0);
  });

  it('does nothing for a peer that is not active', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer({ status: 'unreachable' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await syncPeerMutationLog(PEER, 'periodic')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs one pull per peer at a time', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer();
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight -= 1;
      return new Response(JSON.stringify({ events: [], hasMore: false, checkpoint: 0 }), { status: 200 });
    });
    await Promise.all([
      syncPeerMutationLog(PEER, 'periodic', ['dm', 'profile']),
      syncPeerMutationLog(PEER, 'accept_new'),
    ]);
    expect(maxInFlight).toBe(1);
  });
});

describe('syncPeerMutationLog: refused events', () => {
  it('keeps an event refused for now, moves the cursor past it, and holds its conversation behind it', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer();
    processRelayEvents.mockImplementation(async ([e]) => (
      e!.messageId === 'm1'
        ? { accepted: [], rejected: [{ messageId: 'm1', reason: 'channel_not_found' }], undeliverable: [] }
        : { accepted: [e!.messageId], rejected: [], undeliverable: [] }
    ));
    serve({ dm: [{ events: [event('m1', 100), event('m2', 200), event('other', 250, 'ch-2')], checkpoint: 250, checkpointId: 'r3' }] });
    const result = await syncPeerMutationLog(PEER, 'periodic', ['dm']);

    expect(result).toMatchObject({ applied: 1, deferred: 2, dropped: 0 });
    expect(cursor('dm')).toEqual({ cursorTs: 250, cursorId: 'r3' });
    expect(keptEvents()).toEqual([
      { messageId: 'm1', lastReason: 'channel_not_found', attempts: 1 },
      { messageId: 'm2', lastReason: 'held_behind_earlier_event', attempts: 1 },
    ]);
    // m2 was not applied ahead of m1; the other conversation was not held.
    expect(processRelayEvents.mock.calls.map(c => c[0][0]!.messageId)).toEqual(['m1', 'other']);
  });

  it('counts a duplicate as held and drops a refusal for good', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    processRelayEvents.mockImplementation(async ([e]) => ({
      accepted: [],
      rejected: [{ messageId: e!.messageId, reason: e!.messageId === 'dup' ? 'duplicate' : 'attribution_mismatch' }],
      undeliverable: [],
    }));
    serve({ dm: [{ events: [event('dup', 100), event('bad', 200, 'ch-2')], checkpoint: 200 }] });
    const result = await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    expect(result).toMatchObject({ applied: 0, duplicates: 1, dropped: 1, deferred: 0 });
    expect(keptEvents()).toEqual([]);
  });
});

describe('syncPeerMutationLog: kept events are one row per distinct event', () => {
  function reaction(emoji: string, at: number): FederationRelayEvent {
    return {
      eventType: 'reaction_add', dmChannelId: 'ch-1', messageId: 'm1', encryptionVersion: 0, timestamp: at,
      reaction: { messageId: 'm1', messageHomeInstance: PEER_ORIGIN, userId: 'u', homeUserId: 'u', homeInstance: PEER_ORIGIN, emoji, createdAt: at },
    };
  }

  it('keeps two events that share a type, a message and a millisecond', async () => {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    seedPeer();
    processRelayEvents.mockImplementation(async ([e]) => ({
      accepted: [], rejected: [{ messageId: e!.messageId, reason: 'user_not_found' }], undeliverable: [],
    }));
    serve({ dm: [{ events: [reaction('👍', 700), reaction('🎉', 700)], checkpoint: 700, checkpointId: 'r2' }] });
    await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    const kept = testDb.select({ eventJson: schema.federationSyncRetry.eventJson }).from(schema.federationSyncRetry).all()
      .map(row => (JSON.parse(row.eventJson) as FederationRelayEvent).reaction?.emoji);
    expect(kept.sort()).toEqual(['🎉', '👍'].sort());
  });

  it('adds nothing when a pass reads a kept event again', async () => {
    const { syncPeerMutationLog, syncEventHash } = await import('./federationSync.js');
    seedPeer();
    processRelayEvents.mockImplementation(async ([e]) => ({
      accepted: [], rejected: [{ messageId: e!.messageId, reason: 'user_not_found' }], undeliverable: [],
    }));
    serve({ dm: [{ events: [reaction('👍', 700)], checkpoint: 700, checkpointId: 'r1' }] });
    await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    vi.restoreAllMocks();
    // The overlap reads it again, with its keys in another order.
    const { reaction: r, ...rest } = reaction('👍', 700);
    serve({ dm: [{ events: [{ reaction: r, ...rest }], checkpoint: 700, checkpointId: 'r1' }] });
    await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    const rows = testDb.select({ eventHash: schema.federationSyncRetry.eventHash }).from(schema.federationSyncRetry).all();
    expect(rows).toEqual([{ eventHash: syncEventHash(reaction('👍', 700)) }]);
  });
});

describe('processSyncRetryTick', () => {
  async function keepTwo(): Promise<void> {
    const { syncPeerMutationLog } = await import('./federationSync.js');
    processRelayEvents.mockImplementation(async ([e]) => ({
      accepted: [], rejected: [{ messageId: e!.messageId, reason: 'participant_not_found' }], undeliverable: [],
    }));
    serve({ dm: [{ events: [event('m1', 100), event('m2', 200)], checkpoint: 200 }] });
    await syncPeerMutationLog(PEER, 'periodic', ['dm']);
    expect(keptEvents().map(k => k.messageId)).toEqual(['m1', 'm2']);
  }

  it('replays kept events in order once due, and a unit stops at its first event still refused', async () => {
    const { processSyncRetryTick, SYNC_RETRY_BACKOFF_MS } = await import('./federationSync.js');
    seedPeer();
    await keepTwo();

    // Not due yet.
    expect(await processSyncRetryTick(Date.now())).toBe(0);

    const later = Date.now() + SYNC_RETRY_BACKOFF_MS[0]! + 1;
    processRelayEvents.mockReset();
    processRelayEvents.mockImplementation(async ([e]) => ({
      accepted: [], rejected: [{ messageId: e!.messageId, reason: 'participant_not_found' }], undeliverable: [],
    }));
    expect(await processSyncRetryTick(later)).toBe(0);
    expect(processRelayEvents.mock.calls.map(c => c[0][0]!.messageId)).toEqual(['m1']);
    expect(keptEvents()[0]).toMatchObject({ messageId: 'm1', attempts: 2 });

    processRelayEvents.mockReset();
    processRelayEvents.mockImplementation(async (events) => ({ accepted: events.map(e => e.messageId), rejected: [], undeliverable: [] }));
    expect(await processSyncRetryTick(later + SYNC_RETRY_BACKOFF_MS[1]! + 1)).toBe(2);
    expect(processRelayEvents.mock.calls.map(c => c[0][0]!.messageId)).toEqual(['m1', 'm2']);
    expect(keptEvents()).toEqual([]);
  });

  it('drops a kept event after seven days with a warning, and moves on to the next', async () => {
    const { processSyncRetryTick, SYNC_RETRY_MAX_AGE_MS } = await import('./federationSync.js');
    seedPeer();
    await keepTwo();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    processRelayEvents.mockReset();
    processRelayEvents.mockImplementation(async (events) => ({ accepted: events.map(e => e.messageId), rejected: [], undeliverable: [] }));

    const firstFailed = testDb.select().from(schema.federationSyncRetry).all()[0]!.firstFailedAt;
    testDb.update(schema.federationSyncRetry)
      .set({ firstFailedAt: firstFailed - SYNC_RETRY_MAX_AGE_MS - 1 })
      .where(eq(schema.federationSyncRetry.messageId, 'm1'))
      .run();
    expect(await processSyncRetryTick(Date.now() + 120_000)).toBe(2);
    expect(processRelayEvents.mock.calls.map(c => c[0][0]!.messageId)).toEqual(['m2']);
    expect(warn.mock.calls.some(c => String(c[0]).includes('Dropped create m1'))).toBe(true);
  });

  it('drops kept events without replaying them when the peer is a new incarnation', async () => {
    const { processSyncRetryTick, SYNC_RETRY_BACKOFF_MS } = await import('./federationSync.js');
    seedPeer({ peerInstanceId: 'epoch-a' });
    await keepTwo();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The same peer row, reactivated for a reset peer.
    testDb.update(schema.federationPeers).set({ peerInstanceId: 'epoch-b' }).where(eq(schema.federationPeers.id, PEER)).run();
    processRelayEvents.mockReset();
    expect(await processSyncRetryTick(Date.now() + SYNC_RETRY_BACKOFF_MS[0]! + 1)).toBe(0);
    expect(processRelayEvents).not.toHaveBeenCalled();
    expect(keptEvents()).toEqual([]);
    expect(cursor('dm')).toEqual({ cursorTs: 0, cursorId: null });
    expect(warn.mock.calls.some(c => String(c[0]).includes('new incarnation'))).toBe(true);
  });

  it('leaves kept events of a peer that is not active', async () => {
    const { processSyncRetryTick } = await import('./federationSync.js');
    seedPeer();
    await keepTwo();
    testDb.update(schema.federationPeers).set({ status: 'unreachable' }).where(eq(schema.federationPeers.id, PEER)).run();
    processRelayEvents.mockReset();
    expect(await processSyncRetryTick(Date.now() + 10 * 86_400_000)).toBe(0);
    expect(processRelayEvents).not.toHaveBeenCalled();
    expect(keptEvents()).toHaveLength(2);
  });
});

describe('syncContextKey', () => {
  it('orders DM events by conversation, friend events by pair, profiles by user', async () => {
    const { syncContextKey } = await import('./federationSync.js');
    expect(syncContextKey('dm', event('m', 1, 'ch-9'))).toBe('dm:ch-9');
    const friend = (from: string, to: string): FederationRelayEvent => ({
      eventType: 'friend_add', messageId: 'x', encryptionVersion: 0, timestamp: 1,
      friendship: { from: { homeUserId: from, homeInstance: 'https://a.example' }, to: { homeUserId: to, homeInstance: 'a.example' }, createdAt: 1 },
    });
    expect(syncContextKey('friend', friend('u1', 'u2'))).toBe(syncContextKey('friend', friend('u2', 'u1')));
  });
});
