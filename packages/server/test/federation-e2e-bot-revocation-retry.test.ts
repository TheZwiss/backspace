import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:net';
import { bootTransportPeered, readDb, withWritableDb, type PeeredHarness } from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances and real signed S2S calls.
vi.setConfig({ testTimeout: 45_000 });

/**
 * ── e2e: a bot revoke that waits for the host to come back ──────────────────
 *
 * A is the bot's home, B hosts the bot's federated account. B goes away from
 * A's point of view; the owner resets the bot's tokens on A. The revoke cannot
 * reach B, so A keeps it in `bot_revocations` (bots.md, "Revocation retries")
 * and refuses B a new credential or proof for the bot meanwhile. A retry while
 * B is still away keeps the row; B comes back; the next retry lands: B's
 * account is tombstoned, the row is gone and the bot may register on B again.
 *
 * "Away" is A's peer row for B pointing at a port nobody listens on, so every
 * call A makes to B is refused at the TCP level: the same `unreachable` path a
 * stopped host takes, without stopping a process (a graceful stop through
 * `pnpm exec` can wait on open connections). "Back" restores the real origin.
 * B keeps running, so its account is removed by a real signed call.
 *
 * The retry worker ticks every 5 minutes, so the test runs each pass itself
 * through the test-only route `POST /api/admin/test/bot-revocations/run`, with
 * a clock past the row's next attempt (a tick with the real clock finds no
 * row due).
 */

interface ErrBody { code?: string; error?: string }
interface AuthBody extends ErrBody { token: string; user: { id: string; username: string } }
interface BotCreated { bot: { id: string; username: string }; token: string }
interface RegenBody { token: string; federation: Record<string, { success: boolean; error?: string; pending?: boolean }> }
interface RunBody { done: number; retried: number; dropped: number }
interface HomeBot { id: string; username: string; token: string }

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let aHost: string;
let bHost: string;
let owner: TestUser;
let bot: HomeBot;
let hostBotId: string;
let hostBotToken: string;
/** The origin A's peer row for B holds right now. */
let peerOrigin: string;

async function api<T>(
  inst: SpawnedInstance,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${inst.origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed as T };
}

/** The bot's client flow on B: home-issued secret, attach proof, register. */
async function registerOnHost(homeBot: HomeBot): Promise<{ status: number; body: AuthBody }> {
  const cred = await api<{ secret: string }>(A, 'POST', '/api/users/@me/federation-credential', homeBot.token, { origin: B.origin });
  expect(cred.status).toBe(200);
  const proof = await api<{ token: string }>(A, 'POST', '/api/auth/attach-proof', homeBot.token, { targetDomain: bHost });
  expect(proof.status).toBe(200);
  return api<AuthBody>(B, 'POST', '/api/auth/register', null, {
    username: `${homeBot.username}@${aHost}`,
    password: cred.body.secret,
    homeInstance: aHost,
    homeUserId: homeBot.id,
    botProof: proof.body.token,
  });
}

function revocationRows(): Array<{ origin: string; mode: string; attempts: number; lastError: string | null }> {
  return readDb(A, db => db.prepare(
    'SELECT origin, mode, attempts, last_error AS lastError FROM bot_revocations WHERE bot_id = ?',
  ).all(bot.id) as Array<{ origin: string; mode: string; attempts: number; lastError: string | null }>);
}

function hostRow(id: string): { isDeleted: number } | undefined {
  return readDb(B, db => db.prepare('SELECT is_deleted AS isDeleted FROM users WHERE id = ?').get(id) as { isDeleted: number } | undefined);
}

/**
 * One retry pass on A with its clock `aheadMs` in the future, so the queued
 * row is due: each pass pushes the next attempt further out (5 min, 10, ...).
 */
function runRetries(aheadMs: number): Promise<{ status: number; body: RunBody }> {
  return api<RunBody>(A, 'POST', '/api/admin/test/bot-revocations/run', null, { at: Date.now() + aheadMs });
}

const HOUR = 60 * 60 * 1000;

/** A local port nothing listens on: bound once by the kernel, then let go. */
function deadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

/**
 * A's peer row for B points at `origin` (A reads it on every call to B). The
 * row stays `active` with no failures counted: A's health check runs in this
 * profile and may mark a dead origin unreachable, and a host that is back is
 * one the health check has seen again.
 */
function pointPeerAt(origin: string): void {
  withWritableDb(A, db => {
    const changed = db.prepare(
      "UPDATE federation_peers SET origin = ?, status = 'active', consecutive_failures = 0 WHERE origin = ?",
    ).run(origin, peerOrigin).changes;
    expect(changed).toBe(1);
  });
  peerOrigin = origin;
}

beforeAll(async () => {
  h = await bootTransportPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  aHost = new URL(A.origin).hostname;
  bHost = new URL(B.origin).hostname;
  owner = await registerLocal(A, 'revoker');
  const created = await api<BotCreated>(A, 'POST', '/api/bots', owner.token, { name: 'retry_bot' });
  expect(created.status).toBe(201);
  bot = { id: created.body.bot.id, username: created.body.bot.username, token: created.body.token };
  const registered = await registerOnHost(bot);
  expect(registered.status).toBe(201);
  hostBotId = registered.body.user.id;
  hostBotToken = registered.body.token;
  // The transport profile peers A with B under B's transport origin.
  peerOrigin = B.origin;
}, 120_000);

afterAll(async () => {
  await h?.cleanup();
}, 30_000);

describe('a revoke the host misses while it is away', () => {
  it('is reported as pending and kept on the home', async () => {
    pointPeerAt(`http://127.0.0.1:${await deadPort()}`);
    // iat is in whole seconds: revocation compares against it.
    await new Promise(r => setTimeout(r, 1_100));

    const regen = await api<RegenBody>(A, 'POST', `/api/bots/${bot.id}/token`, owner.token);
    expect(regen.status).toBe(200);
    const outcomes = Object.values(regen.body.federation);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ success: false, pending: true });
    bot = { ...bot, token: regen.body.token };

    const rows = revocationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'soft', attempts: 1 });
  });

  it('blocks a new credential and a new proof for that host while it waits', async () => {
    const cred = await api<ErrBody>(A, 'POST', '/api/users/@me/federation-credential', bot.token, { origin: B.origin });
    expect(cred.status).toBe(409);
    expect(cred.body.code).toBe('bot_revocation_pending');
    const proof = await api<ErrBody>(A, 'POST', '/api/auth/attach-proof', bot.token, { targetDomain: bHost });
    expect(proof.status).toBe(409);
    expect(proof.body.code).toBe('bot_revocation_pending');
  });

  it('a retry while the host is still away keeps the row and counts the attempt', async () => {
    const run = await runRetries(HOUR);
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ done: 0, retried: 1, dropped: 0 });
    expect(revocationRows()[0]).toMatchObject({ attempts: 2 });
  });

  it('the host comes back: the next retry lands, the account there is gone and the row with it', async () => {
    pointPeerAt(B.origin);
    // B kept the bot's account while it was away: its JWT still works there.
    expect(hostRow(hostBotId)?.isDeleted).toBe(0);
    expect((await api<unknown>(B, 'GET', '/api/spaces', hostBotToken)).status).toBe(200);

    // A day ahead: past the pause the previous attempt set, within the 7-day limit.
    const run = await runRetries(24 * HOUR);
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ done: 1, retried: 0, dropped: 0 });
    expect(revocationRows()).toEqual([]);

    expect(hostRow(hostBotId)?.isDeleted).toBe(1);
    expect((await api<unknown>(B, 'GET', '/api/spaces', hostBotToken)).status).toBe(401);
  });

  it('the bot may register on the host again', async () => {
    const res = await registerOnHost(bot);
    expect(res.status).toBe(201);
    expect(res.body.user.id).not.toBe(hostBotId);
  });
});
