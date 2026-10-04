import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  bootTransportPeered,
  readDb,
  waitUntil,
  withWritableDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances, real sockets, real signed S2S calls.
vi.setConfig({ testTimeout: 45_000 });

/**
 * ── e2e: bots across instances ──────────────────────────────────────────────
 *
 * A is the bot's home, B hosts the space. TRANSPORT profile: both identities
 * are the bare host 127.0.0.1 (extractDomain drops the port), the same shape
 * the first-contact suite relies on.
 *
 * Covered: the bot flag on the host comes only from the home's signed proof
 * (a client cannot claim it, a human's proof does not grant it, a proof is
 * single-use, an unpeered home is refused); that row receives the space's
 * messages and reads history like any member; a token regeneration on the home
 * tombstones the host account and kills its JWT, and the bot can register anew.
 */

interface ErrBody { code?: string; error?: string }
interface AuthBody extends ErrBody { token: string; user: { id: string; username: string } }
interface BotCreated { bot: { id: string; username: string }; token: string }
interface RegenBody { token: string; federation: Record<string, { success: boolean; error?: string }> }

interface HomeBot { id: string; username: string; token: string }
interface HostBot { id: string; token: string }

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let aHost: string;
let bHost: string;
let owner: TestUser;
let hostHuman: TestUser;
let bot: HomeBot;
let hostBot: HostBot;
let spaceId: string;
let channelId: string;
const sockets: WsCapture[] = [];

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

async function createBot(name: string, user: TestUser = owner): Promise<HomeBot> {
  const res = await api<BotCreated>(A, 'POST', '/api/bots', user.token, { name });
  expect(res.status).toBe(201);
  return { id: res.body.bot.id, username: res.body.bot.username, token: res.body.token };
}

/** A one-time attach proof for B, minted on A by whoever holds `token`. */
async function mintProof(token: string): Promise<string> {
  const res = await api<{ token: string }>(A, 'POST', '/api/auth/attach-proof', token, { targetDomain: bHost });
  expect(res.status).toBe(200);
  return res.body.token;
}

/** The bot's client flow on B: home-issued secret, proof, register. */
async function registerOnHost(homeBot: HomeBot, proofOverride?: string) {
  const cred = await api<{ secret: string }>(A, 'POST', '/api/users/@me/federation-credential', homeBot.token, { origin: B.origin });
  expect(cred.status).toBe(200);
  const proof = proofOverride ?? await mintProof(homeBot.token);
  return api<AuthBody>(B, 'POST', '/api/auth/register', null, {
    username: `${homeBot.username}@${aHost}`,
    password: cred.body.secret,
    homeInstance: aHost,
    homeUserId: homeBot.id,
    botProof: proof,
  });
}

function hostRow(id: string): { isBot: number; homeUserId: string | null; isDeleted: number } | undefined {
  return readDb(B, db => db.prepare(
    'SELECT is_bot AS isBot, home_user_id AS homeUserId, is_deleted AS isDeleted FROM users WHERE id = ?',
  ).get(id) as { isBot: number; homeUserId: string | null; isDeleted: number } | undefined);
}

function delivered(ws: WsCapture, marker: string): boolean {
  return ws.events.some(e =>
    e.type === 'message_created'
    && ((e.message as { content?: string } | undefined)?.content ?? '').includes(marker));
}

beforeAll(async () => {
  h = await bootTransportPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  aHost = new URL(A.origin).hostname;
  bHost = new URL(B.origin).hostname;
  owner = await registerLocal(A, 'owner');
  hostHuman = await registerLocal(B, 'hosthuman');
  bot = await createBot('echo_bot');
}, 120_000);

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await h?.cleanup();
});

describe('the bot flag on a host instance', () => {
  it('a bot registers on the host with a proof from its home and gets is_bot=1', async () => {
    const res = await registerOnHost(bot);
    expect(res.status).toBe(201);
    hostBot = { id: res.body.user.id, token: res.body.token };
    expect(res.body.user.username).toBe(`${bot.username}@${aHost}`);
    expect(hostRow(hostBot.id)).toEqual({ isBot: 1, homeUserId: bot.id, isDeleted: 0 });
  });

  it('a proof is single-use', async () => {
    const other = await createBot('second_bot');
    const cred = await api<{ secret: string }>(A, 'POST', '/api/users/@me/federation-credential', other.token, { origin: B.origin });
    expect(cred.status).toBe(200);
    const proof = await mintProof(other.token);
    const body = {
      username: `${other.username}@${aHost}`,
      password: cred.body.secret,
      homeInstance: aHost,
      homeUserId: other.id,
      botProof: proof,
    };
    const first = await api<AuthBody>(B, 'POST', '/api/auth/register', null, body);
    expect(first.status).toBe(201);
    const replay = await api<ErrBody>(B, 'POST', '/api/auth/register', null, body);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('bot_proof_invalid');
  });

  it('identity comes from the proof, never from the request body', async () => {
    const third = await createBot('third_bot');
    const cred = await api<{ secret: string }>(A, 'POST', '/api/users/@me/federation-credential', third.token, { origin: B.origin });
    // A valid proof for `bot` (already registered on the host) with third_bot's
    // name in the body: the host must act on the proof's identity and refuse.
    const res = await api<ErrBody>(B, 'POST', '/api/auth/register', null, {
      username: `${third.username}@${aHost}`,
      password: cred.body.secret,
      homeInstance: aHost,
      homeUserId: third.id,
      botProof: await mintProof(bot.token),
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('username_taken');
  });

  it("a human's proof does not grant the flag", async () => {
    const humanProof = await mintProof(owner.token);
    const res = await api<AuthBody & ErrBody>(B, 'POST', '/api/auth/register', null, {
      username: `owner@${aHost}`,
      password: 'a-long-enough-password-1',
      homeInstance: aHost,
      homeUserId: owner.id,
      botProof: humanProof,
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('bot_proof_invalid');
  });

  it('a client cannot claim the flag in the request body', async () => {
    const res = await api<AuthBody>(B, 'POST', '/api/auth/register', null, {
      username: `sneaky_bot@${aHost}`,
      password: 'a-long-enough-password-2',
      homeInstance: aHost,
      homeUserId: 'sneaky-home-id',
      isBot: 1,
    });
    expect(res.status).toBe(201);
    expect(hostRow(res.body.user.id)?.isBot).toBe(0);
  });

  it('a home instance that is not an active peer is refused', async () => {
    const res = await api<ErrBody>(B, 'POST', '/api/auth/register', null, {
      username: 'ghost_bot@unpeered.example',
      password: 'a-long-enough-password-3',
      homeInstance: 'unpeered.example',
      homeUserId: 'ghost-id',
      botProof: 'a'.repeat(64),
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('bot_home_not_peered');
  });
});

describe('a bot in a space on the host', () => {
  it('joins by invite and receives the space messages it can view', async () => {
    const created = await api<{ id?: string; inviteCode?: string; space?: { id: string; inviteCode: string } }>(
      B, 'POST', '/api/spaces', hostHuman.token, { name: 'bot-host-space' },
    );
    expect(created.status).toBeLessThan(300);
    const space = created.body.space ?? created.body;
    spaceId = space.id as string;
    const inviteCode = space.inviteCode as string;

    const chRes = await api<Array<{ id: string; type: string }> | { channels: Array<{ id: string; type: string }> }>(
      B, 'GET', `/api/spaces/${spaceId}/channels`, hostHuman.token,
    );
    const channels = Array.isArray(chRes.body) ? chRes.body : chRes.body.channels;
    channelId = (channels.find(c => c.type === 'text') ?? channels[0]!).id;

    const ws = await connectWs(B.origin, hostBot.token);
    sockets.push(ws);
    await ws.waitForEvent('ready');
    expect((await api<ErrBody>(B, 'POST', '/api/spaces/join', hostBot.token, { inviteCode })).status).toBe(200);

    const say = (content: string) =>
      api<unknown>(B, 'POST', `/api/channels/${channelId}/messages`, hostHuman.token, { content });
    await say('plain-marker');
    await say(`<@${hostBot.id}> mention-marker`);
    // What to do with a message is the bot's code's decision, not the server's.
    expect(await waitUntil(() => delivered(ws, 'plain-marker') && delivered(ws, 'mention-marker'), 5_000)).toBe(true);
  });

  it('reads history like any member, and can post', async () => {
    const hist = await api<unknown>(B, 'GET', `/api/channels/${channelId}/messages`, hostBot.token);
    expect(hist.status).toBe(200);
    const post = await api<unknown>(B, 'POST', `/api/channels/${channelId}/messages`, hostBot.token, { content: 'bot-post-marker' });
    expect(post.status).toBe(201);
  });
});

describe('editing a bot on its home', () => {
  it('only the owner can edit, and the input is validated', async () => {
    const stranger = await registerLocal(A, 'stranger');
    const foreign = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, stranger.token, { displayName: 'Hijack' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('bot_not_found');

    const selfEdit = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, bot.token, { displayName: 'Self' });
    expect(selfEdit.status).toBe(403);

    const empty = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { displayName: '   ' });
    expect(empty.status).toBe(400);
    const tooLong = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { displayName: 'x'.repeat(29) + '_bot' });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('display_name_too_long');
    for (const bad of ['Echo Prime', '_bot', '   _bot', 'bot_x', 'echo_bot_x']) {
      const r = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { displayName: bad });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('bot_name_suffix_required');
    }
    const selfRename = await api<ErrBody>(A, 'PATCH', '/api/users/@me', bot.token, { displayName: 'renamed' });
    expect(selfRename.status).toBe(403);
    expect(selfRename.body.code).toBe('bot_profile_owner_only');
    const badAvatar = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { avatar: '../etc/passwd' });
    expect(badAvatar.body.code).toBe('avatar_url_invalid');
    const nothing = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, {});
    expect(nothing.body.code).toBe('no_fields_to_update');
  });

  it('a display name change on the home reaches the bot account on the host', async () => {
    const res = await api<{ bot: { username: string; displayName: string | null } }>(
      A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { displayName: 'echo_prime_bot' },
    );
    expect(res.status).toBe(200);
    expect(res.body.bot.displayName).toBe('echo_prime_bot');
    expect(res.body.bot.username).toBe(bot.username);

    const reached = await waitUntil(() => readDb(B, db =>
      (db.prepare('SELECT display_name AS name FROM users WHERE id = ?').get(hostBot.id) as { name: string | null } | undefined)?.name,
    ) === 'echo_prime_bot', 15_000);
    expect(reached).toBe(true);
  });

  it('the _bot suffix is added on creation when missing', async () => {
    const plain = await api<BotCreated>(A, 'POST', '/api/bots', owner.token, { name: 'plainname' });
    expect(plain.status).toBe(201);
    expect(plain.body.bot.username).toBe('plainname_bot');
    const already = await api<BotCreated>(A, 'POST', '/api/bots', owner.token, { name: 'Has_Bot' });
    expect(already.body.bot.username).toBe('has_bot');
    const noStem = await api<ErrBody>(A, 'POST', '/api/bots', owner.token, { name: '_bot' });
    expect(noStem.status).toBe(400);
    expect(noStem.body.code).toBe('bot_name_invalid');
  });
});

describe('bringing a bot into a space by button', () => {
  it('the owner adds their bot to a space they manage, once', async () => {
    const created = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'bot-button-space' });
    expect(created.status).toBeLessThan(300);
    const sid = (created.body.space ?? created.body).id as string;

    const before = await api<{ spaces: Array<{ id: string; botIsMember: boolean }> }>(A, 'GET', `/api/bots/${bot.id}/spaces`, owner.token);
    expect(before.body.spaces.find(s => s.id === sid)?.botIsMember).toBe(false);

    const add = await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, owner.token, { spaceId: sid });
    expect(add.status).toBe(200);
    const again = await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, owner.token, { spaceId: sid });
    expect(again.status).toBe(409);

    const after = await api<{ spaces: Array<{ id: string; botIsMember: boolean }> }>(A, 'GET', `/api/bots/${bot.id}/spaces`, owner.token);
    expect(after.body.spaces.find(s => s.id === sid)?.botIsMember).toBe(true);
  });

  it('a caller without MANAGE_SPACE in the target space is refused', async () => {
    const stranger = await registerLocal(A, 'stranger2');
    const ownSpace = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'not-yours' });
    const sid = (ownSpace.body.space ?? ownSpace.body).id as string;
    const noPerm = await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, stranger.token, { spaceId: sid });
    expect(noPerm.status).toBe(403);
    expect(noPerm.body.code).toBe('missing_permission');

    const noSpace = await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, stranger.token, { spaceId: 'x' });
    expect(noSpace.status).toBe(404);
    expect(noSpace.body.code).toBe('space_not_found');
  });
});

describe('a manager invites a bot they do not own', () => {
  it("a space manager adds someone else's native bot, and either side can take it out", async () => {
    const other = await registerLocal(A, 'botother');
    const otherBot = await api<BotCreated>(A, 'POST', '/api/bots', other.token, { name: 'others' });
    expect(otherBot.status).toBe(201);
    const manager = await registerLocal(A, 'spacemanager');
    const made = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', manager.token, { name: 'managed-space' });
    const sid = (made.body.space ?? made.body).id as string;

    const add = await api<ErrBody>(A, 'POST', `/api/bots/${otherBot.body.bot.id}/spaces`, manager.token, { spaceId: sid });
    expect(add.status).toBe(200);

    // The owner took no part, yet sees the membership and can end it.
    const list = await api<{ spaces: Array<{ id: string; botIsMember: boolean }> }>(A, 'GET', `/api/bots/${otherBot.body.bot.id}/spaces`, other.token);
    expect(list.body.spaces.find(s => s.id === sid)?.botIsMember).toBe(true);
    expect((await api<ErrBody>(A, 'DELETE', `/api/bots/${otherBot.body.bot.id}/spaces/${sid}`, other.token)).status).toBe(200);

    // The manager can remove the bot they invited, too.
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${otherBot.body.bot.id}/spaces`, manager.token, { spaceId: sid })).status).toBe(200);
    expect((await api<ErrBody>(A, 'DELETE', `/api/bots/${otherBot.body.bot.id}/spaces/${sid}`, manager.token)).status).toBe(200);
  });

  it("the bot's owner still needs MANAGE_SPACE in the target space", async () => {
    const other = await registerLocal(A, 'botowner2');
    const otherBot = await api<BotCreated>(A, 'POST', '/api/bots', other.token, { name: 'owners' });
    expect(otherBot.status).toBe(201);
    const manager = await registerLocal(A, 'spacemanager2');
    const made = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', manager.token, { name: 'not-your-space' });
    const sid = (made.body.space ?? made.body).id as string;
    const res = await api<ErrBody>(A, 'POST', `/api/bots/${otherBot.body.bot.id}/spaces`, other.token, { spaceId: sid });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('missing_permission');
  });

  it('only a native bot is inviteable: a human or a federated bot account answers 404', async () => {
    const manager = await registerLocal(A, 'spacemanager3');
    const made = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', manager.token, { name: 'native-only' });
    const sid = (made.body.space ?? made.body).id as string;
    const human = await api<ErrBody>(A, 'POST', `/api/bots/${manager.id}/spaces`, manager.token, { spaceId: sid });
    expect(human.status).toBe(404);
    expect(human.body.code).toBe('bot_not_found');

    // A federated bot account on B belongs to its home instance: not inviteable there.
    const homeBot = await createBot('fedtarget_bot');
    const reg = await registerOnHost(homeBot);
    expect(reg.status).toBe(201);
    const madeB = await api<{ id?: string; space?: { id: string } }>(B, 'POST', '/api/spaces', hostHuman.token, { name: 'native-bots-only' });
    const sidB = (madeB.body.space ?? madeB.body).id as string;
    const fed = await api<ErrBody>(B, 'POST', `/api/bots/${reg.body.user.id}/spaces`, hostHuman.token, { spaceId: sidB });
    expect(fed.status).toBe(404);
    expect(fed.body.code).toBe('bot_not_found');
  });

  it('inviting a bot that already sits in the space answers already_member', async () => {
    const other = await registerLocal(A, 'dupowner');
    const otherBot = await createBot('dupbot', other);
    const manager = await registerLocal(A, 'dupmanager');
    const made = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', manager.token, { name: 'dup-space' });
    const sid = (made.body.space ?? made.body).id as string;
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${otherBot.id}/spaces`, manager.token, { spaceId: sid })).status).toBe(200);
    const again = await api<ErrBody>(A, 'POST', `/api/bots/${otherBot.id}/spaces`, manager.token, { spaceId: sid });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_member');
  });

  it('a manager cannot bring back a bot that is banned in the space', async () => {
    const other = await registerLocal(A, 'banowner');
    const otherBot = await createBot('banned', other);
    const manager = await registerLocal(A, 'banmanager');
    const made = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', manager.token, { name: 'ban-space' });
    const sid = (made.body.space ?? made.body).id as string;
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${otherBot.id}/spaces`, manager.token, { spaceId: sid })).status).toBe(200);
    const ban = await api<ErrBody>(A, 'POST', `/api/spaces/${sid}/bans`, manager.token, { userId: otherBot.id });
    expect(ban.status).toBeLessThan(300);
    const back = await api<ErrBody>(A, 'POST', `/api/bots/${otherBot.id}/spaces`, manager.token, { spaceId: sid });
    expect(back.status).toBe(403);
    expect(back.body.code).toBe('user_banned');
  });

  it('a banned bot stops receiving the space events at once', async () => {
    const botOwner = await registerLocal(A, 'banliveowner');
    const live = await createBot('banlive', botOwner);
    const made = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'ban-live-space' });
    const sid = (made.body.space ?? made.body).id as string;
    const chRes = await api<Array<{ id: string; type: string }> | { channels: Array<{ id: string; type: string }> }>(
      A, 'GET', `/api/spaces/${sid}/channels`, owner.token,
    );
    const channels = Array.isArray(chRes.body) ? chRes.body : chRes.body.channels;
    const cid = (channels.find(c => c.type === 'text') ?? channels[0]!).id;

    const ws = await connectWs(A.origin, live.token);
    sockets.push(ws);
    await ws.waitForEvent('ready');
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${live.id}/spaces`, owner.token, { spaceId: sid })).status).toBe(200);

    const say = (content: string) => api<unknown>(A, 'POST', `/api/channels/${cid}/messages`, owner.token, { content });
    await say('before-ban-marker');
    expect(await waitUntil(() => delivered(ws, 'before-ban-marker'), 5_000)).toBe(true);

    const ban = await api<ErrBody>(A, 'POST', `/api/spaces/${sid}/bans`, owner.token, { userId: live.id });
    expect(ban.status).toBeLessThan(300);
    await say('after-ban-marker');
    await new Promise(r => setTimeout(r, 1_000));
    expect(delivered(ws, 'after-ban-marker')).toBe(false);
  });

  it('a federated human who manages a space on the host invites and removes a native bot; a bot caller is refused', async () => {
    const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const reg = await api<AuthBody>(B, 'POST', '/api/auth/register', null, {
      username: `fedmgr${tag}@${aHost}`,
      password: `pw_${tag}`,
      homeInstance: aHost,
      homeUserId: `home-${tag}`,
    });
    expect(reg.status).toBe(201);
    const fedToken = reg.body.token;

    const hostBot = await api<BotCreated>(B, 'POST', '/api/bots', hostHuman.token, { name: `hostnative${tag.slice(0, 6)}` });
    expect(hostBot.status).toBe(201);
    const made = await api<{ id?: string; space?: { id: string } }>(B, 'POST', '/api/spaces', fedToken, { name: 'fed-managed' });
    expect(made.status).toBeLessThan(300);
    const sid = (made.body.space ?? made.body).id as string;

    const add = await api<ErrBody>(B, 'POST', `/api/bots/${hostBot.body.bot.id}/spaces`, fedToken, { spaceId: sid });
    expect(add.status).toBe(200);
    const remove = await api<ErrBody>(B, 'DELETE', `/api/bots/${hostBot.body.bot.id}/spaces/${sid}`, fedToken);
    expect(remove.status).toBe(200);

    // Managing bots themselves stays with the native owner account.
    const create = await api<ErrBody>(B, 'POST', '/api/bots', fedToken, { name: 'fedmade' });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('bots_native_only');

    // A bot may not invite bots.
    const byBot = await api<ErrBody>(B, 'POST', `/api/bots/${hostBot.body.bot.id}/spaces`, hostBot.body.token, { spaceId: sid });
    expect(byBot.status).toBe(403);
    expect(byBot.body.code).toBe('bots_native_only');
  });
});

describe('the bot search for invitations', () => {
  it('finds native bots by username substring; humans are not listed', async () => {
    const other = await registerLocal(A, 'botsearcher');
    const made = await api<BotCreated>(A, 'POST', '/api/bots', other.token, { name: 'xylophone' });
    expect(made.status).toBe(201);

    const seeker = await registerLocal(A, 'searchseeker');
    const res = await api<{ bots: Array<{ id: string; username: string }> }>(A, 'GET', '/api/bots/search?q=xyloph', seeker.token);
    expect(res.status).toBe(200);
    expect(res.body.bots.some(b => b.username === 'xylophone_bot')).toBe(true);
    expect(res.body.bots.every(b => b.username.endsWith('_bot'))).toBe(true);

    // The owner's own bots are listed too: a directory, not a policy.
    const own = await api<{ bots: Array<{ id: string; username: string }> }>(A, 'GET', '/api/bots/search?q=xyloph', other.token);
    expect(own.body.bots.some(b => b.username === 'xylophone_bot')).toBe(true);

    const none = await api<{ bots: unknown[] }>(A, 'GET', `/api/bots/search?q=${seeker.username}`, seeker.token);
    expect(none.status).toBe(200);
    expect(none.body.bots).toHaveLength(0);
  });

  it('% and _ in the query are literal characters, and out-of-range lengths find nothing', async () => {
    const wildOwner = await registerLocal(A, 'wildowner');
    const wild = await createBot('wildcard', wildOwner);
    expect(wild.username).toBe('wildcard_bot');
    const seeker = await registerLocal(A, 'wildseeker');
    const find = async (q: string) => (await api<{ bots: Array<{ username: string }> }>(
      A, 'GET', `/api/bots/search?q=${encodeURIComponent(q)}`, seeker.token,
    )).body.bots;
    expect((await find('wildc')).some(b => b.username === 'wildcard_bot')).toBe(true);
    expect(await find('%%')).toHaveLength(0);
    expect(await find('w_ldcard')).toHaveLength(0);
    expect(await find('w')).toHaveLength(0);
    expect(await find('x'.repeat(33))).toHaveLength(0);
  });

  it('names the owner of each bot, unless the owner is not discoverable', async () => {
    const named = await registerLocal(A, 'ownershown');
    const bot = await createBot('ownedbot', named);
    const seeker = await registerLocal(A, 'ownerseeker');
    const find = async () => (await api<{ bots: Array<{ username: string; ownerUsername: string | null }> }>(
      A, 'GET', `/api/bots/search?q=${encodeURIComponent(bot.username)}`, seeker.token,
    )).body.bots.find(b => b.username === bot.username);
    expect((await find())?.ownerUsername).toBe(named.username);
    const hide = await api<ErrBody>(A, 'PATCH', '/api/users/@me', named.token, { discoverable: false });
    expect(hide.status).toBeLessThan(300);
    expect((await find())?.ownerUsername).toBeNull();
  });
});

describe('a bot in direct and group conversations on its home', () => {
  let botWs: WsCapture;
  let groupId: string;

  const dmDelivered = (marker: string): boolean =>
    botWs.events.some(e =>
      e.type === 'dm_message_created'
      && ((e.message as { content?: string } | undefined)?.content ?? '').includes(marker));

  it('in a group DM the bot receives every message and can read it', async () => {
    const member = await registerLocal(A, 'groupmate');
    groupId = `e2e-group-${Date.now()}`;
    withWritableDb(A, db => {
      db.prepare('INSERT INTO dm_channels (id, owner_id, federated_id, created_at) VALUES (?, ?, ?, ?)')
        .run(groupId, owner.id, randomUUID(), Date.now());
      const add = db.prepare('INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?, ?, 0)');
      for (const uid of [owner.id, bot.id, member.id]) add.run(groupId, uid);
    });
    botWs = await connectWs(A.origin, bot.token);
    sockets.push(botWs);
    await botWs.waitForEvent('ready');

    await api<unknown>(A, 'POST', `/api/dm/${groupId}/messages`, owner.token, { content: 'group-marker' });
    expect(await waitUntil(() => dmDelivered('group-marker'), 5_000)).toBe(true);
    expect((await api<unknown>(A, 'GET', `/api/dm/${groupId}/messages`, bot.token)).status).toBe(200);
  });

  it('in a 1-on-1 DM the bot receives messages and can read them', async () => {
    const dm = await api<{ id?: string; dmChannel?: { id: string } }>(
      A, 'POST', '/api/dm', owner.token, { userId: bot.id },
    );
    expect(dm.status).toBeLessThan(300);
    const dmId = (dm.body.dmChannel?.id ?? dm.body.id) as string;
    await api<unknown>(A, 'POST', `/api/dm/${dmId}/messages`, owner.token, { content: 'one-on-one-marker' });
    expect(await waitUntil(() => dmDelivered('one-on-one-marker'), 5_000)).toBe(true);
    expect((await api<unknown>(A, 'GET', `/api/dm/${dmId}/messages`, bot.token)).status).toBe(200);
  });

  it('the owner starts a group DM with their own bot without a friendship, and a stranger\'s bot is refused', async () => {
    const friend = await registerLocal(A, 'groupfriend');
    // owner and friend must be friends for the ordinary part of the check
    const req = await api<ErrBody>(A, 'POST', '/api/social/requests', owner.token, { username: friend.username });
    expect(req.status).toBeLessThan(300);
    const incoming = await api<Array<{ id: string }> | { requests: Array<{ id: string }> }>(A, 'GET', '/api/social/requests', friend.token);
    const list = Array.isArray(incoming.body) ? incoming.body : incoming.body.requests;
    expect(list.length).toBeGreaterThan(0);
    const accept = await api<ErrBody>(A, 'PATCH', `/api/social/requests/${list[0]!.id}`, friend.token, { status: 'accepted' });
    expect(accept.status).toBeLessThan(300);

    const made = await api<{ id?: string; members?: Array<{ id: string }> }>(
      A, 'POST', '/api/dm/group', owner.token, { users: [{ id: friend.id }, { id: bot.id }] },
    );
    expect(made.status).toBe(201);
    expect(made.body.members?.map(m => m.id)).toContain(bot.id);

    const stranger = await registerLocal(A, 'groupstranger');
    const strangerBot = await api<BotCreated>(A, 'POST', '/api/bots', stranger.token, { name: 'strangers2' });
    const refused = await api<ErrBody>(
      A, 'POST', '/api/dm/group', owner.token, { users: [{ id: friend.id }, { id: strangerBot.body.bot.id }] },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('not_a_friend');
  });
});

describe('the Bot authorization scheme', () => {
  it('accepts a bot token as `Authorization: Bot <token>` and rejects other schemes', async () => {
    const ok = await fetch(`${A.origin}/api/spaces`, { headers: { Authorization: `Bot ${bot.token}` } });
    expect(ok.status).toBe(200);
    const bearer = await fetch(`${A.origin}/api/spaces`, { headers: { Authorization: `Bearer ${bot.token}` } });
    expect(bearer.status).toBe(200);
    const other = await fetch(`${A.origin}/api/spaces`, { headers: { Authorization: `Basic ${bot.token}` } });
    expect(other.status).toBe(401);
  });

  it('accepts the Bot scheme when creating an upload', async () => {
    const meta = `filename ${Buffer.from('bot.txt').toString('base64')},filetype ${Buffer.from('text/plain').toString('base64')}`;
    const createWith = (auth: string) => fetch(`${A.origin}/api/files/`, {
      method: 'POST',
      headers: { Authorization: auth, 'Tus-Resumable': '1.0.0', 'Upload-Length': '5', 'Upload-Metadata': meta },
    });
    expect((await createWith(`Bot ${bot.token}`)).status).toBe(201);
    expect((await createWith(`Basic ${bot.token}`)).status).toBe(401);
  });
});

describe('reactions over REST', () => {
  const count = (table: 'reactions' | 'dm_reactions', column: 'message_id' | 'dm_message_id', messageId: string): number =>
    readDb(A, db => (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(messageId) as { n: number }).n);
  const emoji = encodeURIComponent('👍');

  it('a bot reacts to a space message and removes the reaction; repeats change nothing', async () => {
    const created = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'bot-reaction-space' });
    const sid = (created.body.space ?? created.body).id as string;
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, owner.token, { spaceId: sid })).status).toBe(200);
    const chRes = await api<Array<{ id: string; type: string }> | { channels: Array<{ id: string; type: string }> }>(
      A, 'GET', `/api/spaces/${sid}/channels`, owner.token,
    );
    const channels = Array.isArray(chRes.body) ? chRes.body : chRes.body.channels;
    const cid = (channels.find(c => c.type === 'text') ?? channels[0]!).id;
    const msg = await api<{ id: string }>(A, 'POST', `/api/channels/${cid}/messages`, owner.token, { content: 'react-to-me' });
    expect(msg.status).toBe(201);
    const mid = msg.body.id;

    const add = await api<{ changed: boolean }>(A, 'PUT', `/api/messages/${mid}/reactions/${emoji}`, bot.token);
    expect(add.status).toBe(200);
    expect(add.body.changed).toBe(true);
    expect(count('reactions', 'message_id', mid)).toBe(1);
    const again = await api<{ changed: boolean }>(A, 'PUT', `/api/messages/${mid}/reactions/${emoji}`, bot.token);
    expect(again.body.changed).toBe(false);

    const remove = await api<{ changed: boolean }>(A, 'DELETE', `/api/messages/${mid}/reactions/${emoji}`, bot.token);
    expect(remove.status).toBe(200);
    expect(remove.body.changed).toBe(true);
    expect(count('reactions', 'message_id', mid)).toBe(0);

    // A user outside the space learns nothing about the message.
    const stranger = await registerLocal(A, 'reactstranger');
    const outsider = await api<ErrBody>(A, 'PUT', `/api/messages/${mid}/reactions/${emoji}`, stranger.token);
    expect(outsider.status).toBe(404);
    expect(outsider.body.code).toBe('message_not_found');
  });

  it('a bot reacts to a message in its 1-on-1 DM', async () => {
    const dm = await api<{ id?: string; dmChannel?: { id: string } }>(A, 'POST', '/api/dm', owner.token, { userId: bot.id });
    const dmId = (dm.body.dmChannel?.id ?? dm.body.id) as string;
    const msg = await api<{ id: string }>(A, 'POST', `/api/dm/${dmId}/messages`, owner.token, { content: 'dm-react-to-me' });
    expect(msg.status).toBe(201);

    expect((await api<unknown>(A, 'PUT', `/api/messages/${msg.body.id}/reactions/${emoji}`, bot.token)).status).toBe(200);
    expect(count('dm_reactions', 'dm_message_id', msg.body.id)).toBe(1);
    expect((await api<unknown>(A, 'DELETE', `/api/messages/${msg.body.id}/reactions/${emoji}`, bot.token)).status).toBe(200);
    expect(count('dm_reactions', 'dm_message_id', msg.body.id)).toBe(0);
  });

  it('rejects a bad emoji and an unknown message', async () => {
    const tooLong = await api<ErrBody>(A, 'PUT', `/api/messages/1/reactions/${'x'.repeat(65)}`, bot.token);
    expect(tooLong.status).toBe(400);
    const unknown = await api<ErrBody>(A, 'PUT', `/api/messages/999999999999/reactions/${emoji}`, bot.token);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('message_not_found');
  });
});

describe('taking a bot out of a space', () => {
  let sid: string;
  let cid: string;

  it('the owner removes their bot: the member is gone and live events stop', async () => {
    const created = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'bot-removal-space' });
    sid = (created.body.space ?? created.body).id as string;
    const chRes = await api<Array<{ id: string; type: string }> | { channels: Array<{ id: string; type: string }> }>(
      A, 'GET', `/api/spaces/${sid}/channels`, owner.token,
    );
    const channels = Array.isArray(chRes.body) ? chRes.body : chRes.body.channels;
    cid = (channels.find(c => c.type === 'text') ?? channels[0]!).id;

    const ws = await connectWs(A.origin, bot.token);
    sockets.push(ws);
    await ws.waitForEvent('ready');
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, owner.token, { spaceId: sid })).status).toBe(200);

    const say = (content: string) => api<unknown>(A, 'POST', `/api/channels/${cid}/messages`, owner.token, { content });
    await say('before-removal-marker');
    expect(await waitUntil(() => delivered(ws, 'before-removal-marker'), 5_000)).toBe(true);

    expect((await api<ErrBody>(A, 'DELETE', `/api/bots/${bot.id}/spaces/${sid}`, owner.token)).status).toBe(200);
    // The removed bot still hears that it is out, then nothing more from that space.
    expect(await waitUntil(() => ws.events.some(e => e.type === 'member_left' && e.userId === bot.id), 5_000)).toBe(true);
    await say('after-removal-marker');
    await new Promise(r => setTimeout(r, 1_000));
    expect(delivered(ws, 'after-removal-marker')).toBe(false);

    const list = await api<{ spaces: Array<{ id: string; botIsMember: boolean }> }>(A, 'GET', `/api/bots/${bot.id}/spaces`, owner.token);
    expect(list.body.spaces.find(s => s.id === sid)?.botIsMember).toBe(false);
  });

  it('removing a non-member, or someone else\'s bot, is refused', async () => {
    const again = await api<ErrBody>(A, 'DELETE', `/api/bots/${bot.id}/spaces/${sid}`, owner.token);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('member_not_found');

    const stranger = await registerLocal(A, 'removestranger');
    const foreign = await api<ErrBody>(A, 'DELETE', `/api/bots/${bot.id}/spaces/${sid}`, stranger.token);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('missing_permission');
  });
});

describe('slash command registration', () => {
  interface CommandsBody { commands: Array<{ id: string; name: string; description: string; options: Array<{ name: string; required: boolean }> }> }
  interface InvalidBody { code?: string; details?: { field?: string; reason?: string } }

  const play = {
    name: 'play',
    description: 'Play a track',
    options: [
      { name: 'query', description: 'What to play', type: 'string', required: true },
      { name: 'volume', description: 'Volume', type: 'integer', choices: [{ name: 'low', value: 20 }, { name: 'high', value: 80 }] },
    ],
  };

  it('a bot registers its commands and reads them back; a second call replaces them and keeps ids', async () => {
    const put = await api<CommandsBody>(A, 'PUT', '/api/bots/@me/commands', bot.token, {
      commands: [play, { name: 'stop', description: 'Stop playing' }],
    });
    expect(put.status).toBe(200);
    expect(put.body.commands.map(c => c.name)).toEqual(['play', 'stop']);
    expect(put.body.commands[0]!.options.map(o => o.name)).toEqual(['query', 'volume']);
    expect(put.body.commands[0]!.options[0]!.required).toBe(true);
    expect(put.body.commands[0]!.options[1]!.required).toBe(false);

    const read = await api<CommandsBody>(A, 'GET', '/api/bots/@me/commands', bot.token);
    expect(read.body.commands.map(c => c.name)).toEqual(['play', 'stop']);

    const stopId = put.body.commands.find(c => c.name === 'stop')!.id;
    const replaced = await api<CommandsBody>(A, 'PUT', '/api/bots/@me/commands', bot.token, {
      commands: [{ name: 'stop', description: 'Stop it now' }],
    });
    expect(replaced.body.commands).toHaveLength(1);
    expect(replaced.body.commands[0]!.id).toBe(stopId);
    expect(replaced.body.commands[0]!.description).toBe('Stop it now');
  });

  it('rejects an invalid definition and says which field is wrong', async () => {
    const bad: Array<[string, unknown]> = [
      ['an uppercase name', [{ name: 'Play Now', description: 'x' }]],
      ['duplicate names', [{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }]],
      ['an empty description', [{ name: 'a', description: '' }]],
      ['a required option after an optional one', [{ name: 'a', description: 'x', options: [
        { name: 'o1', description: 'x', type: 'string' },
        { name: 'o2', description: 'x', type: 'string', required: true },
      ] }]],
      ['a choice of the wrong type', [{ name: 'a', description: 'x', options: [
        { name: 'o', description: 'x', type: 'integer', choices: [{ name: 'n', value: 'text' }] },
      ] }]],
      ['a fractional integer choice', [{ name: 'a', description: 'x', options: [
        { name: 'o', description: 'x', type: 'integer', choices: [{ name: 'n', value: 1.5 }] },
      ] }]],
      ['choices on a boolean', [{ name: 'a', description: 'x', options: [
        { name: 'o', description: 'x', type: 'boolean', choices: [{ name: 'n', value: 1 }] },
      ] }]],
      ['an unknown option type', [{ name: 'a', description: 'x', options: [{ name: 'o', description: 'x', type: 'user' }] }]],
      ['eleven options', [{ name: 'a', description: 'x', options: Array.from({ length: 11 }, (_, i) => ({ name: `o${i}`, description: 'x', type: 'string' })) }]],
      ['a list that is not an array', 'play'],
    ];
    for (const [label, commands] of bad) {
      const res = await api<InvalidBody>(A, 'PUT', '/api/bots/@me/commands', bot.token, { commands });
      expect(res.status, label).toBe(400);
      expect(res.body.code, label).toBe('validation_failed');
      expect(typeof res.body.details?.field, label).toBe('string');
    }
    const named = await api<InvalidBody>(A, 'PUT', '/api/bots/@me/commands', bot.token, {
      commands: [{ name: 'Play Now', description: 'x' }],
    });
    expect(named.body.details?.field).toBe('commands[0].name');
  });

  it('only a bot account may register or read commands', async () => {
    const human = await api<InvalidBody>(A, 'PUT', '/api/bots/@me/commands', owner.token, { commands: [] });
    expect(human.status).toBe(403);
    expect(human.body.code).toBe('bot_account_required');
    const read = await api<InvalidBody>(A, 'GET', '/api/bots/@me/commands', owner.token);
    expect(read.status).toBe(403);
  });
});

describe('invoking a slash command', () => {
  interface InteractionEvent {
    id: string;
    command: string;
    options: Record<string, unknown>;
    user: { id: string };
    channelId?: string;
    dmChannelId?: string;
    spaceId?: string;
  }
  interface InvokeBody { id?: string; expiresAt?: number; code?: string; details?: { field?: string } }
  interface Listed { commands: Array<{ name: string; bot: { id: string } }> }

  const play = {
    name: 'play',
    description: 'Play a track',
    options: [
      { name: 'query', description: 'What to play', type: 'string', required: true },
      { name: 'volume', description: 'Volume', type: 'integer', choices: [{ name: 'low', value: 20 }, { name: 'high', value: 80 }] },
    ],
  };

  let sid: string;
  let cid: string;
  let invocationId: string;
  let botWs: WsCapture;

  const received = (id: string): InteractionEvent | undefined => {
    for (const e of botWs.events) {
      if (e.type === 'interaction_created' && (e.interaction as InteractionEvent).id === id) return e.interaction as InteractionEvent;
    }
    return undefined;
  };
  const invoke = (token: string, body: unknown) => api<InvokeBody>(A, 'POST', '/api/interactions', token, body);
  const respond = (token: string, id: string, content: string) =>
    api<{ content?: string; code?: string }>(A, 'POST', `/api/interactions/${id}/respond`, token, { content });

  it('lists the commands of the bots in a chat and delivers an invocation to the bot', async () => {
    const created = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'bot-slash-space' });
    sid = (created.body.space ?? created.body).id as string;
    const chRes = await api<Array<{ id: string; type: string }> | { channels: Array<{ id: string; type: string }> }>(
      A, 'GET', `/api/spaces/${sid}/channels`, owner.token,
    );
    const channels = Array.isArray(chRes.body) ? chRes.body : chRes.body.channels;
    cid = (channels.find(c => c.type === 'text') ?? channels[0]!).id;
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, owner.token, { spaceId: sid })).status).toBe(200);
    expect((await api<unknown>(A, 'PUT', '/api/bots/@me/commands', bot.token, { commands: [play] })).status).toBe(200);

    botWs = await connectWs(A.origin, bot.token);
    sockets.push(botWs);
    await botWs.waitForEvent('ready');

    const listed = await api<Listed>(A, 'GET', `/api/commands?channelId=${cid}`, owner.token);
    expect(listed.status).toBe(200);
    expect(listed.body.commands.map(c => `${c.name}:${c.bot.id}`)).toEqual([`play:${bot.id}`]);

    const res = await invoke(owner.token, { botId: bot.id, command: 'play', options: { query: 'song', volume: 80 }, channelId: cid });
    expect(res.status).toBe(201);
    invocationId = res.body.id!;
    expect(invocationId).toMatch(/^[0-9a-f]{32}$/);
    expect(await waitUntil(() => received(invocationId) !== undefined, 5_000)).toBe(true);
    const event = received(invocationId)!;
    expect(event.command).toBe('play');
    expect(event.options).toEqual({ query: 'song', volume: 80 });
    expect(event.user.id).toBe(owner.id);
    expect(event.channelId).toBe(cid);
    expect(event.spaceId).toBe(sid);
  });

  it('the bot answers through the ordinary message route, up to five times', async () => {
    for (let n = 1; n <= 5; n++) {
      const r = await respond(bot.token, invocationId, `reply ${n}`);
      expect(r.status, `response ${n}`).toBe(201);
      expect(r.body.content).toBe(`reply ${n}`);
    }
    const sixth = await respond(bot.token, invocationId, 'one too many');
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('interaction_responses_exceeded');

    const history = await api<Array<{ content: string }>>(A, 'GET', `/api/channels/${cid}/messages`, owner.token);
    const contents = history.body.map(m => m.content);
    expect(contents).toContain('reply 5');
    expect(contents).not.toContain('one too many');
  });

  it('refuses a bad invocation and names the wrong option', async () => {
    const base = { botId: bot.id, command: 'play', channelId: cid };
    const cases: Array<[string, unknown, number, string, string?]> = [
      ['a missing required option', { ...base, options: {} }, 400, 'validation_failed', 'options.query'],
      ['a value outside the choices', { ...base, options: { query: 'x', volume: 50 } }, 400, 'validation_failed', 'options.volume'],
      ['a wrongly typed value', { ...base, options: { query: 5 } }, 400, 'validation_failed', 'options.query'],
      ['an unknown option', { ...base, options: { query: 'x', extra: 1 } }, 400, 'validation_failed', 'options.extra'],
      ['an unknown command', { ...base, command: 'nope' }, 404, 'command_not_found'],
      ['both chat targets', { ...base, dmChannelId: 'x', options: { query: 'x' } }, 400, 'validation_failed'],
    ];
    for (const [label, body, status, code, field] of cases) {
      const res = await invoke(owner.token, body);
      expect(res.status, label).toBe(status);
      expect(res.body.code, label).toBe(code);
      if (field) expect(res.body.details?.field, label).toBe(field);
    }
  });

  it('only someone who may write in the chat can invoke, and only the invoked bot may answer', async () => {
    const outsider = await registerLocal(A, 'slashoutsider');
    const denied = await invoke(outsider.token, { botId: bot.id, command: 'play', options: { query: 'x' }, channelId: cid });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('missing_permission');

    const rival = await createBot('rival_bot');
    const stolen = await respond(rival.token, invocationId, 'mine now');
    expect(stolen.status).toBe(404);
    expect(stolen.body.code).toBe('interaction_not_found');
    const human = await respond(owner.token, invocationId, 'x');
    expect(human.status).toBe(403);
    expect(human.body.code).toBe('bot_account_required');

    const notInChat = await invoke(owner.token, { botId: rival.id, command: 'play', options: { query: 'x' }, channelId: cid });
    expect(notInChat.status).toBe(404);
    expect(notInChat.body.code).toBe('bot_not_found');
  });

  it('works in a direct message with the bot', async () => {
    const dm = await api<{ id?: string; dmChannel?: { id: string } }>(A, 'POST', '/api/dm', owner.token, { userId: bot.id });
    const dmId = (dm.body.dmChannel?.id ?? dm.body.id) as string;
    const listed = await api<Listed>(A, 'GET', `/api/commands?dmChannelId=${dmId}`, owner.token);
    expect(listed.body.commands.map(c => c.name)).toEqual(['play']);

    const res = await invoke(owner.token, { botId: bot.id, command: 'play', options: { query: 'dm song' }, dmChannelId: dmId });
    expect(res.status).toBe(201);
    expect(await waitUntil(() => received(res.body.id!) !== undefined, 5_000)).toBe(true);
    expect(received(res.body.id!)!.dmChannelId).toBe(dmId);
    const answer = await respond(bot.token, res.body.id!, 'dm reply');
    expect(answer.status).toBe(201);
    expect(answer.body.content).toBe('dm reply');
  });

  it('refuses a late answer, and an invocation while the bot is offline', async () => {
    withWritableDb(A, db => {
      db.prepare('UPDATE interactions SET expires_at = ? WHERE id = ?').run(Date.now() - 1_000, invocationId);
    });
    const late = await respond(bot.token, invocationId, 'too late');
    expect(late.status).toBe(410);
    expect(late.body.code).toBe('interaction_expired');

    // A bot with no open socket cannot be handed a command.
    const quiet = await createBot('quiet_bot');
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${quiet.id}/spaces`, owner.token, { spaceId: sid })).status).toBe(200);
    expect((await api<unknown>(A, 'PUT', '/api/bots/@me/commands', quiet.token, {
      commands: [{ name: 'hush', description: 'Say nothing' }],
    })).status).toBe(200);
    const offline = await invoke(owner.token, { botId: quiet.id, command: 'hush', channelId: cid });
    expect(offline.status).toBe(409);
    expect(offline.body.code).toBe('bot_unavailable');
  });
});

describe('two bots with the same command name', () => {
  it('the listing tells them apart, and an invocation reaches the bot it names', async () => {
    // A dedicated owner: the suite's main owner is close to the ten-bot limit.
    const clasher = await registerLocal(A, 'clashbots');
    const first = await createBot('alpha_bot', clasher);
    const second = await createBot('beta_bot', clasher);
    const made = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'clash-space' });
    const sid = (made.body.space ?? made.body).id as string;
    for (const b of [first, second]) {
      expect((await api<ErrBody>(A, 'POST', `/api/bots/${b.id}/spaces`, owner.token, { spaceId: sid })).status).toBe(200);
    }
    const chRes = await api<Array<{ id: string; type: string }> | { channels: Array<{ id: string; type: string }> }>(
      A, 'GET', `/api/spaces/${sid}/channels`, owner.token,
    );
    const channels = Array.isArray(chRes.body) ? chRes.body : chRes.body.channels;
    const cid = (channels.find(c => c.type === 'text') ?? channels[0]!).id;

    const definition = {
      name: 'play',
      description: 'Play a track',
      options: [{ name: 'query', description: 'What to play', type: 'string', required: true }],
    };
    for (const b of [first, second]) {
      expect((await api<unknown>(A, 'PUT', '/api/bots/@me/commands', b.token, { commands: [definition] })).status).toBe(200);
    }

    // Both commands are listed, each with its bot, in name-then-username order.
    const list = await api<{ commands: Array<{ name: string; botId: string; bot: { username: string } }> }>(
      A, 'GET', `/api/commands?channelId=${cid}`, owner.token,
    );
    const plays = list.body.commands.filter(c => c.name === 'play');
    expect(plays).toHaveLength(2);
    expect(plays.map(c => c.bot.username)).toEqual([first.username, second.username]);
    expect(plays.every(c => c.botId === (c.bot.username === first.username ? first.id : second.id))).toBe(true);

    // An invocation names the bot; the clash changes nothing about that.
    const wsFirst = await connectWs(A.origin, first.token);
    sockets.push(wsFirst);
    await wsFirst.waitForEvent('ready');
    const wsSecond = await connectWs(A.origin, second.token);
    sockets.push(wsSecond);
    await wsSecond.waitForEvent('ready');

    const got = (ws: WsCapture, id: string): boolean =>
      ws.events.some(e => e.type === 'interaction_created' && (e.interaction as { id?: string } | undefined)?.id === id);
    const invFirst = await api<{ id: string }>(A, 'POST', '/api/interactions', owner.token, { botId: first.id, command: 'play', options: { query: 'song-a' }, channelId: cid });
    const invSecond = await api<{ id: string }>(A, 'POST', '/api/interactions', owner.token, { botId: second.id, command: 'play', options: { query: 'song-b' }, channelId: cid });
    expect(invFirst.status).toBe(201);
    expect(invSecond.status).toBe(201);

    expect(await waitUntil(() => got(wsFirst, invFirst.body.id) && got(wsSecond, invSecond.body.id), 5_000)).toBe(true);
    expect(got(wsFirst, invSecond.body.id)).toBe(false);
    expect(got(wsSecond, invFirst.body.id)).toBe(false);
  });
});

describe('a bot in several voice channels', () => {
  interface VoiceBody { token?: string; url?: string; code?: string }
  let sid: string;
  let voiceA: string;
  let voiceB: string;
  let botWs: WsCapture;

  const voiceEvent = (channelId: string, action: string): boolean =>
    botWs.events.some(e => e.type === 'voice_state_update' && e.channelId === channelId && e.userId === bot.id && e.action === action);

  it('sits in two voice channels at once, each with its own LiveKit token', async () => {
    const created = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'bot-voice-space' });
    sid = (created.body.space ?? created.body).id as string;
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, owner.token, { spaceId: sid })).status).toBe(200);

    const makeVoice = async (name: string): Promise<string> => {
      const r = await api<{ id: string }>(A, 'POST', `/api/spaces/${sid}/channels`, owner.token, { name, type: 'voice' });
      expect(r.status).toBeLessThan(300);
      return r.body.id;
    };
    voiceA = await makeVoice('radio-one');
    voiceB = await makeVoice('radio-two');

    botWs = await connectWs(A.origin, bot.token);
    sockets.push(botWs);
    await botWs.waitForEvent('ready');

    botWs.send({ type: 'bot_voice_join', channelId: voiceA });
    botWs.send({ type: 'bot_voice_join', channelId: voiceB });
    expect(await waitUntil(() => voiceEvent(voiceA, 'join') && voiceEvent(voiceB, 'join'), 5_000)).toBe(true);
    // Joining the second channel did not push the bot out of the first.
    expect(voiceEvent(voiceA, 'leave')).toBe(false);

    const tokenA = await api<VoiceBody>(A, 'POST', '/api/livekit/token', bot.token, { channelId: voiceA });
    const tokenB = await api<VoiceBody>(A, 'POST', '/api/livekit/token', bot.token, { channelId: voiceB });
    expect(tokenA.status).toBe(200);
    expect(tokenB.status).toBe(200);
    expect(tokenA.body.token).not.toBe(tokenB.body.token);
  });

  it('a person sees the bot in both channels, and leaving one keeps the other', async () => {
    const watcher = await connectWs(A.origin, owner.token);
    sockets.push(watcher);
    const ready = await watcher.waitForEvent('ready');
    const states = (ready as { voiceStates?: Record<string, string[]> }).voiceStates ?? {};
    expect(states[voiceA]).toContain(bot.id);
    expect(states[voiceB]).toContain(bot.id);

    botWs.send({ type: 'bot_voice_leave', channelId: voiceA });
    expect(await waitUntil(() => voiceEvent(voiceA, 'leave'), 5_000)).toBe(true);
    expect(voiceEvent(voiceB, 'leave')).toBe(false);
    expect(await waitUntil(() => watcher.events.some(e => e.type === 'voice_state_update' && e.channelId === voiceA && e.userId === bot.id && e.action === 'leave'), 5_000)).toBe(true);
  });

  it('refuses a person using the bot-only events and a channel the bot cannot reach', async () => {
    const humanWs = await connectWs(A.origin, owner.token);
    sockets.push(humanWs);
    await humanWs.waitForEvent('ready');
    humanWs.send({ type: 'bot_voice_join', channelId: voiceB });
    expect(await waitUntil(() => humanWs.events.some(e => e.type === 'error' && e.code === 'bot_account_required'), 5_000)).toBe(true);

    botWs.send({ type: 'bot_voice_join', channelId: 'no-such-channel' });
    expect(await waitUntil(() => botWs.events.some(e => e.type === 'error' && e.message === 'Channel not found'), 5_000)).toBe(true);
  });

  it('removing the bot from the space takes it out of that space\'s voice channels', async () => {
    expect((await api<ErrBody>(A, 'DELETE', `/api/bots/${bot.id}/spaces/${sid}`, owner.token)).status).toBe(200);
    expect(await waitUntil(() => voiceEvent(voiceB, 'leave'), 5_000)).toBe(true);
  });

  it('a bot that drops its connection leaves every voice channel it sat in', async () => {
    // Self-contained: its own bot, space and channels, and ONE socket, so the bot is
    // really offline once that socket closes (any other open socket keeps it online).
    const lone = await createBot('dropper_bot');
    const made = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'bot-drop-space' });
    const dropSpace = (made.body.space ?? made.body).id as string;
    expect((await api<ErrBody>(A, 'POST', `/api/bots/${lone.id}/spaces`, owner.token, { spaceId: dropSpace })).status).toBe(200);
    const makeVoice = async (name: string): Promise<string> => {
      const r = await api<{ id: string }>(A, 'POST', `/api/spaces/${dropSpace}/channels`, owner.token, { name, type: 'voice' });
      expect(r.status).toBeLessThan(300);
      return r.body.id;
    };
    const first = await makeVoice('drop-one');
    const second = await makeVoice('drop-two');

    const watcher = await connectWs(A.origin, owner.token);
    sockets.push(watcher);
    await watcher.waitForEvent('ready');
    const seated = (channelId: string, action: string): boolean =>
      watcher.events.some(e => e.type === 'voice_state_update' && e.channelId === channelId && e.userId === lone.id && e.action === action);

    const own = await connectWs(A.origin, lone.token);
    await own.waitForEvent('ready');
    own.send({ type: 'bot_voice_join', channelId: first });
    own.send({ type: 'bot_voice_join', channelId: second });
    expect(await waitUntil(() => seated(first, 'join') && seated(second, 'join'), 5_000)).toBe(true);

    own.close();
    // The server waits a short grace period (5 s) for a reconnect before it lets go.
    expect(await waitUntil(() => seated(first, 'leave') && seated(second, 'leave'), 20_000)).toBe(true);
  });
});

describe('bot accounts on their home instance', () => {
  interface Created { bot: { id: string; username: string }; token: string }

  const create = (token: string, name: string) => api<Created & ErrBody>(A, 'POST', '/api/bots', token, { name });
  const deleteAccount = (user: TestUser) =>
    api<ErrBody>(A, 'DELETE', '/api/users/@me', user.token, { password: user.password, username: user.username });

  it('limits an owner to ten bots, and a name that is taken is refused', async () => {
    const solo = await registerLocal(A, 'botlimit');
    for (let n = 0; n < 10; n++) {
      const made = await create(solo.token, `lim${n}`);
      expect(made.status, `bot ${n}`).toBe(201);
    }
    const eleventh = await create(solo.token, 'lim_over');
    expect(eleventh.status).toBe(400);
    expect(eleventh.body.code).toBe('bot_limit_reached');

    const other = await registerLocal(A, 'botclash');
    const clash = await create(other.token, 'lim0');
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('username_taken');
  });

  it('a bot cannot create bots, and a bad name is refused', async () => {
    const byBot = await create(bot.token, 'child');
    expect(byBot.status).toBe(403);
    expect(byBot.body.code).toBe('bots_native_only');

    const noStem = await create(owner.token, '!!');
    expect(noStem.status).toBe(400);
    expect(noStem.body.code).toBe('bot_name_invalid');
  });

  it('a new token revokes the old one at once', async () => {
    const solo = await registerLocal(A, 'botrevoke');
    const made = await create(solo.token, 'revokee');
    const oldToken = made.body.token;
    expect((await api<unknown>(A, 'GET', '/api/bots/@me/commands', oldToken)).status).toBe(200);

    // iat is in whole seconds: revocation compares against it.
    await new Promise((r) => setTimeout(r, 1_100));
    const fresh = await api<{ token: string }>(A, 'POST', `/api/bots/${made.body.bot.id}/token`, solo.token);
    expect(fresh.status).toBe(200);
    expect((await api<unknown>(A, 'GET', '/api/bots/@me/commands', oldToken)).status).toBe(401);
    expect((await api<unknown>(A, 'GET', '/api/bots/@me/commands', fresh.body.token)).status).toBe(200);
  });

  it('deleting the owner deletes their bots: tokens stop working and commands are gone', async () => {
    const solo = await registerLocal(A, 'botowner');
    const one = await create(solo.token, 'orphan_one');
    const two = await create(solo.token, 'orphan_two');
    expect((await api<unknown>(A, 'PUT', '/api/bots/@me/commands', one.body.token, {
      commands: [{ name: 'ping', description: 'Ping' }],
    })).status).toBe(200);

    const gone = await deleteAccount(solo);
    expect(gone.status).toBe(200);

    expect((await api<unknown>(A, 'GET', '/api/bots/@me/commands', one.body.token)).status).toBe(401);
    expect((await api<unknown>(A, 'GET', '/api/bots/@me/commands', two.body.token)).status).toBe(401);
    const rows = readDb(A, db => ({
      deleted: (db.prepare('SELECT count(*) AS n FROM users WHERE id IN (?, ?) AND is_deleted = 1').get(one.body.bot.id, two.body.bot.id) as { n: number }).n,
      commands: (db.prepare('SELECT count(*) AS n FROM bot_commands WHERE bot_id = ?').get(one.body.bot.id) as { n: number }).n,
    }));
    expect(rows.deleted).toBe(2);
    expect(rows.commands).toBe(0);
  });
});

describe('bots and friend requests', () => {
  it('a friend request to a bot is refused: bots take no friends', async () => {
    const asker = await registerLocal(A, 'friendasker');
    const res = await api<ErrBody>(A, 'POST', '/api/social/requests', asker.token, { username: bot.username });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bots_no_friends');
  });
});

describe('cutting a bot off from the host', () => {
  it('a token regeneration on the home tombstones the host account and kills its JWT', async () => {
    const oldHomeToken = bot.token;
    // iat is in whole seconds: revocation compares against it.
    await new Promise(r => setTimeout(r, 1_100));

    const regen = await api<RegenBody>(A, 'POST', `/api/bots/${bot.id}/token`, owner.token);
    expect(regen.status).toBe(200);
    const results = Object.values(regen.body.federation);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.success)).toBe(true);
    bot = { ...bot, token: regen.body.token };

    // Home: the old token is revoked, the new one works.
    expect((await api<unknown>(A, 'GET', '/api/spaces', oldHomeToken)).status).toBe(401);
    expect((await api<unknown>(A, 'GET', '/api/spaces', bot.token)).status).toBe(200);

    // Host: the account is tombstoned and its JWT no longer authenticates.
    expect(hostRow(hostBot.id)?.isDeleted).toBe(1);
    expect((await api<unknown>(B, 'GET', '/api/spaces', hostBot.token)).status).toBe(401);
  });

  it('the legitimate bot registers again with its new token', async () => {
    const res = await registerOnHost(bot);
    expect(res.status).toBe(201);
    expect(res.body.user.id).not.toBe(hostBot.id);
    expect(hostRow(res.body.user.id)).toEqual({ isBot: 1, homeUserId: bot.id, isDeleted: 0 });
  });
});
