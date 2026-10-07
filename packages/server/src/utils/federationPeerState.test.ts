import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

const sendToUser = vi.fn();
const sendToAdmins = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: (...args: unknown[]) => sendToAdmins(...args),
    getAllOnlineUserIds: () => ['local-user'],
    sendToUser: (...args: unknown[]) => sendToUser(...args),
  },
}));

const onPeerActivated = vi.fn(async () => undefined);
const onPeerDeactivated = vi.fn(async () => undefined);
vi.mock('./federationPeerActivation.js', () => ({
  onPeerActivated: (...args: unknown[]) => onPeerActivated(...(args as [])),
  onPeerDeactivated: (...args: unknown[]) => onPeerDeactivated(...(args as [])),
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

function seedPeer(values: Partial<typeof schema.federationPeers.$inferInsert> & { id: string; status: string }): void {
  testDb.insert(schema.federationPeers).values({
    origin: `https://${values.id}.example`,
    hmacSecret: 'secret-0',
    createdAt: Date.now(),
    ...values,
  }).run();
}

function seedOutboxEntry(id: string, peerId: string): void {
  testDb.insert(schema.users).values({
    id: `user-${id}`, username: `user_${id}`, passwordHash: 'x', createdAt: Date.now(),
  }).run();
  testDb.insert(schema.dmChannels).values({ id: `dm-${id}`, createdAt: Date.now() }).run();
  testDb.insert(schema.dmMembers).values({ dmChannelId: `dm-${id}`, userId: `user-${id}` }).run();
  testDb.insert(schema.federationOutbox).values({
    id, peerId, contextId: `dm-${id}`, entityId: `m-${id}`,
    contextType: 'dm', eventType: 'create', payload: '{}',
    encryptionVersion: 0, attempts: 0, nextRetryAt: Date.now(),
    expiresAt: Date.now() + 86_400_000, createdAt: Date.now(),
  }).run();
}

function row(id: string): typeof schema.federationPeers.$inferSelect {
  return testDb.select().from(schema.federationPeers).where(eq(schema.federationPeers.id, id)).get()!;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  sendToUser.mockReset();
  sendToAdmins.mockReset();
  onPeerActivated.mockClear();
  onPeerDeactivated.mockClear();
});

afterEach(() => {
  sqlite.close();
});

describe('transitionPeer', () => {
  it('applies only from the expected status (compare-and-set) and reports the current row otherwise', async () => {
    const { transitionPeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'revoked' });

    const outcome = transitionPeer('p1', { from: ['unreachable'], to: 'active', cause: 'health_check_recovery' });

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.current?.status).toBe('revoked');
    expect(row('p1').status).toBe('revoked');
    expect(onPeerActivated).not.toHaveBeenCalled();
  });

  it('does not apply when the row no longer holds the expected secret', async () => {
    const { transitionPeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'pending', hmacSecret: 'theirs' });

    const outcome = transitionPeer('p1', { from: ['pending'], expectSecret: 'ours', to: 'awaiting_approval', cause: 'handshake_queued' });

    expect(outcome.applied).toBe(false);
    expect(row('p1').status).toBe('pending');
  });

  it('writes the reason with the status and clears it when the row leaves a status that carries one', async () => {
    const { transitionPeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'active' });

    transitionPeer('p1', { from: ['active'], to: 'needs_attention', reason: 'auth_failures', cause: 'auth_threshold' });
    expect(row('p1').statusReason).toBe('auth_failures');

    seedPeer({ id: 'p2', status: 'rejected', statusReason: 'stale_peering_on_remote' });
    transitionPeer('p2', { from: ['rejected'], to: 'pending', cause: 'retry_after_remote_reset' });
    expect(row('p2').statusReason).toBeNull();
  });

  it('starts the attempt pacing afresh on entering unreachable', async () => {
    const { transitionPeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'active', probeAttempts: 4, lastProbeAt: 123 });

    transitionPeer('p1', { from: ['active'], to: 'unreachable', cause: 'network_threshold' });

    expect(row('p1').status).toBe('unreachable');
    expect(row('p1').probeAttempts).toBe(0);
    expect(row('p1').lastProbeAt).toBeNull();
  });

  it('runs the activation hook and tells users once, on entering active', async () => {
    const { transitionPeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'unreachable', probeAttempts: 2, lastProbeAt: 5 });

    const outcome = transitionPeer('p1', { from: ['unreachable'], to: 'active', cause: 'health_check_recovery' });
    if (outcome.applied) await outcome.done;

    expect(onPeerActivated).toHaveBeenCalledTimes(1);
    expect(onPeerActivated).toHaveBeenCalledWith('p1', 'health_check_recovery');
    expect(sendToUser).toHaveBeenCalledWith('local-user', { type: 'federation_peer_active', peerOrigin: 'https://p1.example' });
    expect(row('p1').probeAttempts).toBe(0);

    onPeerActivated.mockClear();
    const again = transitionPeer('p1', { from: ['active'], to: 'active', cause: 'initiate_accepted', fields: { hmacSecret: 'secret-1' } });
    if (again.applied) await again.done;
    expect(onPeerActivated).not.toHaveBeenCalled();
    expect(row('p1').hmacSecret).toBe('secret-1');
  });

  it('runs the deactivation hook on leaving active, with the cause', async () => {
    const { transitionPeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'active' });

    const outcome = transitionPeer('p1', {
      from: ['active', 'unreachable', 'needs_attention'],
      to: 'needs_attention',
      reason: 'peer_reset_detected',
      cause: 'reset_detected',
    });
    if (outcome.applied) await outcome.done;

    expect(onPeerDeactivated).toHaveBeenCalledWith('p1', 'reset_detected');
  });

  it('on entering rejected, purges the outbox and tells the affected users why, with a reason code', async () => {
    const { transitionPeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'pending' });
    seedOutboxEntry('e1', 'p1');

    const outcome = transitionPeer('p1', { from: ['pending'], to: 'rejected', reason: 'revoked_by_remote', cause: 'remote_refused' });
    if (outcome.applied) await outcome.done;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(testDb.select().from(schema.federationOutbox).all()).toHaveLength(0);
    expect(sendToUser).toHaveBeenCalledWith('user-e1', expect.objectContaining({
      type: 'federation_peer_rejected',
      peerOrigin: 'https://p1.example',
      reasonCode: 'revoked_by_remote',
    }));
  });

  it('on entering needs_attention after auth failures, keeps the entries but tells the users', async () => {
    const { transitionPeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'active' });
    seedOutboxEntry('e1', 'p1');

    const outcome = transitionPeer('p1', { from: ['active'], to: 'needs_attention', reason: 'auth_failures', cause: 'auth_threshold' });
    if (outcome.applied) await outcome.done;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(testDb.select().from(schema.federationOutbox).all()).toHaveLength(1);
    expect(sendToUser).toHaveBeenCalledWith('user-e1', expect.objectContaining({ reasonCode: 'auth_failures' }));
  });
});

describe('recordPeerAttempt', () => {
  it('counts a failed attempt only while the row is still in the expected status', async () => {
    const { recordPeerAttempt } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'pending' });
    seedPeer({ id: 'p2', status: 'active' });

    expect(recordPeerAttempt('p1', { from: ['pending'], startedAt: 1000 })).toBe(true);
    expect(recordPeerAttempt('p2', { from: ['pending'], startedAt: 1000 })).toBe(false);

    expect(row('p1').probeAttempts).toBe(1);
    expect(row('p1').lastProbeAt).toBe(1000);
    expect(row('p2').probeAttempts).toBe(0);
  });
});

describe('insertPeer and removePeer', () => {
  it('insertPeer returns null instead of overwriting a row for the same origin', async () => {
    const { insertPeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'active', origin: 'https://remote.example' });

    const inserted = insertPeer({ origin: 'https://remote.example', hmacSecret: 's', initiatedBy: 'auto', status: 'pending' });

    expect(inserted).toBeNull();
    expect(row('p1').status).toBe('active');
  });

  it('insertPeer writes the rejected reason', async () => {
    const { insertPeer } = await import('./federationPeerState.js');
    const inserted = insertPeer({
      origin: 'https://remote.example', hmacSecret: 's', initiatedBy: 'admin',
      status: 'rejected', reason: 'denied_by_local_admin',
    });
    expect(inserted?.row.statusReason).toBe('denied_by_local_admin');
  });

  it('removePeer with unlessQueued keeps a row that has outbox entries', async () => {
    const { removePeer } = await import('./federationPeerState.js');
    seedPeer({ id: 'p1', status: 'pending' });
    seedOutboxEntry('e1', 'p1');
    seedPeer({ id: 'p2', status: 'pending' });

    expect(removePeer('p1', { from: ['pending'], unlessQueued: true })).toBe(false);
    expect(removePeer('p2', { from: ['pending'], unlessQueued: true })).toBe(true);
    expect(removePeer('p1', { from: ['active'] })).toBe(false);
  });
});

describe('decideInboundHandshake', () => {
  const base = {
    autoAccept: true,
    inboundToken: undefined,
    ownHandshakeInFlight: false,
    ourOrigin: 'https://b.example',
    sourceOrigin: 'https://c.example',
  };
  type Row = { status: string; statusReason: string | null; initiatedBy: 'admin' | 'auto' | 'remote'; approvalToken: string | null };
  const r = (status: string, extra: Partial<Row> = {}): Row => ({
    status, statusReason: null, initiatedBy: 'auto', approvalToken: null, ...extra,
  });

  it('creates a new peer with auto-accept on, queues it with auto-accept off', async () => {
    const { decideInboundHandshake } = await import('./federationPeerState.js');
    expect(decideInboundHandshake({ ...base, row: null })).toEqual({ kind: 'create' });
    expect(decideInboundHandshake({ ...base, autoAccept: false, row: null })).toEqual({ kind: 'queue' });
  });

  it.each(['active', 'unreachable', 'needs_attention'])(
    'answers a handshake for an established (%s) peering with 409, whatever the setting',
    async (status) => {
      const { decideInboundHandshake } = await import('./federationPeerState.js');
      expect(decideInboundHandshake({ ...base, row: r(status) })).toEqual({ kind: 'refuse_exists' });
      expect(decideInboundHandshake({ ...base, autoAccept: false, row: r(status) })).toEqual({ kind: 'refuse_exists' });
    },
  );

  it('refuses a revoked origin with either setting', async () => {
    const { decideInboundHandshake } = await import('./federationPeerState.js');
    expect(decideInboundHandshake({ ...base, row: r('revoked') })).toEqual({ kind: 'refuse_revoked' });
    expect(decideInboundHandshake({ ...base, autoAccept: false, row: r('revoked') })).toEqual({ kind: 'refuse_revoked' });
  });

  it('keeps an origin our admin denied blocked, with auto-accept on too', async () => {
    const { decideInboundHandshake } = await import('./federationPeerState.js');
    const denied = r('rejected', { statusReason: 'denied_by_local_admin', initiatedBy: 'admin' });
    expect(decideInboundHandshake({ ...base, row: denied })).toEqual({ kind: 'refuse_denied' });
    expect(decideInboundHandshake({ ...base, autoAccept: false, row: denied })).toEqual({ kind: 'refuse_denied' });
  });

  it('takes the handshake of a remote that refused us earlier: activate with auto-accept on or an admin row, else queue', async () => {
    const { decideInboundHandshake } = await import('./federationPeerState.js');
    for (const reason of ['denied_by_remote', 'revoked_by_remote', 'expired_on_remote', 'stale_peering_on_remote']) {
      expect(decideInboundHandshake({ ...base, row: r('rejected', { statusReason: reason }) }))
        .toEqual({ kind: 'activate', from: 'rejected', cause: 'accept_rejected_override' });
      expect(decideInboundHandshake({ ...base, autoAccept: false, row: r('rejected', { statusReason: reason, initiatedBy: 'admin' }) }))
        .toEqual({ kind: 'activate', from: 'rejected', cause: 'accept_rejected_override' });
      expect(decideInboundHandshake({ ...base, autoAccept: false, row: r('rejected', { statusReason: reason }) }))
        .toEqual({ kind: 'queue' });
    }
  });

  it('keeps the old behaviour for a rejected row without a reason', async () => {
    const { decideInboundHandshake } = await import('./federationPeerState.js');
    expect(decideInboundHandshake({ ...base, row: r('rejected') }))
      .toEqual({ kind: 'activate', from: 'rejected', cause: 'accept_rejected_override' });
    expect(decideInboundHandshake({ ...base, autoAccept: false, row: r('rejected', { initiatedBy: 'admin' }) }))
      .toEqual({ kind: 'refuse_denied' });
  });

  it.each(['repeer_incomplete', 'peer_reset_detected', 'auth_failures', 'not_a_reason'])(
    'answers a rejected row whose reason (%s) is not a remote refusal as a row without a reason',
    async (reason) => {
      const { decideInboundHandshake } = await import('./federationPeerState.js');
      // A needs_attention row our admin denied before the upgrade: 403, as before.
      expect(decideInboundHandshake({ ...base, autoAccept: false, row: r('rejected', { statusReason: reason }) }))
        .toEqual({ kind: 'refuse_denied' });
      expect(decideInboundHandshake({ ...base, autoAccept: false, row: r('rejected', { statusReason: reason, initiatedBy: 'admin' }) }))
        .toEqual({ kind: 'refuse_denied' });
      expect(decideInboundHandshake({ ...base, row: r('rejected', { statusReason: reason }) }))
        .toEqual({ kind: 'activate', from: 'rejected', cause: 'accept_rejected_override' });
    },
  );

  it('activates a pending row, gated on admin provenance with auto-accept off', async () => {
    const { decideInboundHandshake } = await import('./federationPeerState.js');
    expect(decideInboundHandshake({ ...base, row: r('pending') }))
      .toEqual({ kind: 'activate', from: 'pending', cause: 'accept_pending' });
    expect(decideInboundHandshake({ ...base, autoAccept: false, row: r('pending') })).toEqual({ kind: 'queue' });
    expect(decideInboundHandshake({ ...base, autoAccept: false, row: r('pending', { initiatedBy: 'admin' }) }))
      .toEqual({ kind: 'activate', from: 'pending', cause: 'accept_pending' });
  });

  it('with both sides handshaking at once, the lower origin keeps its own handshake', async () => {
    const { decideInboundHandshake } = await import('./federationPeerState.js');
    // We are lower: refuse theirs.
    expect(decideInboundHandshake({ ...base, ownHandshakeInFlight: true, row: r('pending') }))
      .toEqual({ kind: 'refuse_in_progress' });
    // We are higher: take theirs.
    expect(decideInboundHandshake({
      ...base, ownHandshakeInFlight: true, ourOrigin: 'https://d.example', row: r('pending'),
    })).toEqual({ kind: 'activate', from: 'pending', cause: 'accept_pending' });
  });

  it('awaiting_approval: a valid token activates, else auto-accept falls back, else queue', async () => {
    const { decideInboundHandshake } = await import('./federationPeerState.js');
    const waiting = r('awaiting_approval', { approvalToken: 'tok', initiatedBy: 'admin' });
    expect(decideInboundHandshake({ ...base, autoAccept: false, inboundToken: 'tok', row: waiting }))
      .toEqual({ kind: 'activate', from: 'awaiting_approval', cause: 'accept_awaiting_approval' });
    expect(decideInboundHandshake({ ...base, inboundToken: 'other', row: waiting }))
      .toEqual({ kind: 'activate', from: 'awaiting_approval', cause: 'accept_awaiting_approval_fallback' });
    expect(decideInboundHandshake({ ...base, autoAccept: false, inboundToken: 'other', row: waiting }))
      .toEqual({ kind: 'queue' });
  });
});
