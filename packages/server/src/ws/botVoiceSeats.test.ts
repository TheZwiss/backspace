import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '../utils/permissions.js';

setWorkerId(1);

/**
 * Bot voice seats (`bot_voice_join`) next to person-style seats (`voice_join`):
 * a bot may only take a voice channel, and one channel is never occupied twice
 * by the same bot through the two paths.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const SPACE = 'sp-bot-seats';
const VOICE_A = 'vc-bot-a';
const VOICE_B = 'vc-bot-b';
const TEXT = 'tc-bot';
const BOT = 'bot-1';

function seed(): void {
  const now = Date.now();
  testDb.insert(schema.users).values({
    id: 'owner', username: 'owner', passwordHash: 'x', homeUserId: 'owner', homeInstance: null, createdAt: now,
  }).run();
  testDb.insert(schema.users).values({
    id: BOT, username: 'bot', passwordHash: '!bot', homeUserId: BOT, homeInstance: null, createdAt: now,
    isBot: 1, botOwnerId: 'owner',
  }).run();
  testDb.insert(schema.spaces).values({ id: SPACE, name: 'S', ownerId: 'owner', createdAt: now }).run();
  testDb.insert(schema.roles).values({
    id: SPACE, spaceId: SPACE, name: '@everyone', color: '#b9bbbe', position: 0,
    permissions: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.CONNECT | PermissionBits.SPEAK),
    createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE, userId: BOT, joinedAt: now }).run();
  for (const [id, type] of [[VOICE_A, 'voice'], [VOICE_B, 'voice'], [TEXT, 'text']] as const) {
    testDb.insert(schema.channels).values({ id, spaceId: SPACE, name: id, type, position: 0, createdAt: now }).run();
  }
}

async function load() {
  const { connectionManager } = await import('./handler.js');
  const { handleClientEvent } = await import('./events.js');
  return { cm: connectionManager, handleClientEvent };
}

const ws = { readyState: 1, send: vi.fn() } as unknown as WebSocket;

beforeEach(() => {
  // connectionManager is a module singleton: a fresh copy per test keeps seats from leaking.
  vi.resetModules();
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bot_voice_join', () => {
  it('refuses a text channel: no seat, an error to the bot', async () => {
    const { cm, handleClientEvent } = await load();
    const sendToUser = vi.spyOn(cm, 'sendToUser');
    handleClientEvent({ type: 'bot_voice_join', channelId: TEXT }, BOT, 'bot', ws, false);
    expect(cm.getBotRoomIds(BOT)).toEqual([]);
    expect(cm.getRoom(TEXT)).toBeFalsy();
    expect(sendToUser).toHaveBeenCalledWith(BOT, expect.objectContaining({ type: 'error', message: 'Target channel is not a voice channel' }));
  });

  it('seats the bot in two voice channels of one space in parallel', async () => {
    const { cm, handleClientEvent } = await load();
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_B }, BOT, 'bot', ws, false);
    expect([...cm.getBotRoomIds(BOT)].sort()).toEqual([VOICE_A, VOICE_B]);
  });

  it('does not take a second seat in a channel the bot holds through voice_join', async () => {
    const { cm, handleClientEvent } = await load();
    handleClientEvent({ type: 'voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    expect(cm.getUserRoom(BOT)?.roomId).toBe(VOICE_A);
    const sendToRoom = vi.spyOn(cm, 'sendToRoom');

    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);

    expect(cm.getBotRoomIds(BOT)).not.toContain(VOICE_A);
    expect(sendToRoom).not.toHaveBeenCalled();
    expect(cm.getUserRoom(BOT)?.roomId).toBe(VOICE_A);
  });
});

describe('voice_join after bot_voice_join', () => {
  it('is a no-op for the channel the bot already sits in', async () => {
    const { cm, handleClientEvent } = await load();
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    const sendToRoom = vi.spyOn(cm, 'sendToRoom');

    handleClientEvent({ type: 'voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);

    expect(cm.getUserRoom(BOT)).toBeNull();
    expect(cm.getBotRoomIds(BOT)).toEqual([VOICE_A]);
    expect(sendToRoom).not.toHaveBeenCalled();
  });
});

/** SPEAK is computed per channel, so a bot's mute is a property of one seat. */
describe('permission mute of a bot seat', () => {
  const denySpeak = (channelId: string, userId: string = BOT) =>
    testDb.insert(schema.channelOverrides).values({
      channelId, targetType: 'member', targetId: userId, allow: '0', deny: PermissionBits.SPEAK.toString(),
    }).run();
  const allowSpeak = (channelId: string, userId: string = BOT) =>
    testDb.delete(schema.channelOverrides).where(and(eq(schema.channelOverrides.channelId, channelId), eq(schema.channelOverrides.targetId, userId))).run();
  const muteEvents = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => c[1] as { type: string; channelId?: string; muted?: boolean }).filter((e) => e.type === 'voice_permission_muted');

  it('muted without SPEAK in one channel stays unmuted in the other', async () => {
    denySpeak(VOICE_A);
    const { cm, handleClientEvent } = await load();
    const sendToSpace = vi.spyOn(cm, 'sendToSpace');
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_B }, BOT, 'bot', ws, false);

    expect(cm.isBotSeatPermissionMuted(VOICE_A, BOT)).toBe(true);
    expect(cm.isBotSeatPermissionMuted(VOICE_B, BOT)).toBe(false);
    expect(cm.isPermissionMuted(SPACE, BOT)).toBe(false);
    expect(muteEvents(sendToSpace)).toEqual([{ type: 'voice_permission_muted', userId: BOT, spaceId: SPACE, channelId: VOICE_A, muted: true }]);

    const snap = cm.buildSpaceVoiceState(SPACE, 'owner').spaceVoiceStates;
    expect(snap[`${SPACE}:${BOT}:${VOICE_A}`]).toMatchObject({ permissionMuted: true });
    expect(snap[`${SPACE}:${BOT}:${VOICE_B}`]).toBeUndefined();
    expect(snap[`${SPACE}:${BOT}`]).toBeUndefined();
  });

  it('leaving the other channel keeps the mute; leaving the muted one lifts it for that channel', async () => {
    denySpeak(VOICE_A);
    const { cm, handleClientEvent } = await load();
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_B }, BOT, 'bot', ws, false);

    handleClientEvent({ type: 'bot_voice_leave', channelId: VOICE_B }, BOT, 'bot', ws, false);
    expect(cm.isBotSeatPermissionMuted(VOICE_A, BOT)).toBe(true);

    const sendToSpace = vi.spyOn(cm, 'sendToSpace');
    handleClientEvent({ type: 'bot_voice_leave', channelId: VOICE_A }, BOT, 'bot', ws, false);
    expect(cm.isBotSeatPermissionMuted(VOICE_A, BOT)).toBe(false);
    expect(muteEvents(sendToSpace)).toEqual([{ type: 'voice_permission_muted', userId: BOT, spaceId: SPACE, channelId: VOICE_A, muted: false }]);
  });

  it('a role change re-judges every seat on its own channel', async () => {
    const { cm, handleClientEvent } = await load();
    const { checkVoicePermissions } = await import('./events.js');
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_B }, BOT, 'bot', ws, false);
    expect(muteEvents(vi.spyOn(cm, 'sendToSpace'))).toEqual([]);

    denySpeak(VOICE_B);
    const sendToSpace = vi.spyOn(cm, 'sendToSpace');
    checkVoicePermissions(SPACE);
    expect(cm.isBotSeatPermissionMuted(VOICE_B, BOT)).toBe(true);
    expect(cm.isBotSeatPermissionMuted(VOICE_A, BOT)).toBe(false);
    expect(muteEvents(sendToSpace)).toEqual([{ type: 'voice_permission_muted', userId: BOT, spaceId: SPACE, channelId: VOICE_B, muted: true }]);

    allowSpeak(VOICE_B);
    sendToSpace.mockClear();
    checkVoicePermissions(SPACE);
    expect(cm.isBotSeatPermissionMuted(VOICE_B, BOT)).toBe(false);
    expect(muteEvents(sendToSpace)).toEqual([{ type: 'voice_permission_muted', userId: BOT, spaceId: SPACE, channelId: VOICE_B, muted: false }]);
  });

  it('leaving one seat keeps the space-wide flags while another seat of the space remains', async () => {
    const { cm, handleClientEvent } = await load();
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_B }, BOT, 'bot', ws, false);
    cm.setSpaceMuted(SPACE, BOT, true);

    handleClientEvent({ type: 'bot_voice_leave', channelId: VOICE_A }, BOT, 'bot', ws, false);
    expect(cm.isSpaceMuted(SPACE, BOT)).toBe(true);

    handleClientEvent({ type: 'bot_voice_leave', channelId: VOICE_B }, BOT, 'bot', ws, false);
    expect(cm.isSpaceMuted(SPACE, BOT)).toBe(false);
  });

  it('a person keeps the per-space flag and an event without a channel', async () => {
    const now = Date.now();
    testDb.insert(schema.users).values({ id: 'p1', username: 'p1', passwordHash: 'x', homeUserId: 'p1', homeInstance: null, createdAt: now }).run();
    testDb.insert(schema.spaceMembers).values({ spaceId: SPACE, userId: 'p1', joinedAt: now }).run();
    denySpeak(VOICE_A, 'p1');
    const { cm, handleClientEvent } = await load();
    const sendToSpace = vi.spyOn(cm, 'sendToSpace');
    handleClientEvent({ type: 'voice_join', channelId: VOICE_A }, 'p1', 'p1', ws, false);

    expect(cm.isPermissionMuted(SPACE, 'p1')).toBe(true);
    expect(muteEvents(sendToSpace)).toEqual([{ type: 'voice_permission_muted', userId: 'p1', spaceId: SPACE, muted: true }]);
  });
});

/** A moderator's mute, deafen and disconnect of one bot seat (bots.md, 5c). */
describe('moderation of a bot seat', () => {
  type Sent = { type: string; userId?: string; channelId?: string; muted?: boolean; deafened?: boolean; botSeat?: boolean; message?: string };
  const sentOfType = (spy: { mock: { calls: unknown[][] } }, type: string) =>
    spy.mock.calls.map((c) => c[1] as Sent).filter((e) => e.type === type);
  const seatRows = () => testDb.select().from(schema.botSeatRestrictions).all();

  async function seated() {
    const ctx = await load();
    ctx.handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    ctx.handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_B }, BOT, 'bot', ws, false);
    return ctx;
  }

  it('mutes the seat in the named channel only, persisted, announced with botSeat', async () => {
    const { cm, handleClientEvent } = await seated();
    const sendToSpace = vi.spyOn(cm, 'sendToSpace');

    handleClientEvent({ type: 'voice_space_mute', userId: BOT, channelId: VOICE_A, muted: true }, 'owner', 'owner', ws, false);

    expect(sentOfType(sendToSpace, 'voice_space_muted')).toEqual([
      { type: 'voice_space_muted', userId: BOT, channelId: VOICE_A, spaceId: SPACE, muted: true, botSeat: true },
    ]);
    expect(seatRows()).toEqual([expect.objectContaining({ channelId: VOICE_A, botId: BOT, restrictionType: 'mute', moderatorId: 'owner' })]);
    // The person-style per-space flag is untouched: the other seat stays unmuted.
    expect(cm.isSpaceMuted(SPACE, BOT)).toBe(false);
    const snap = cm.buildSpaceVoiceState(SPACE, 'owner').spaceVoiceStates;
    expect(snap[`${SPACE}:${BOT}:${VOICE_A}`]).toMatchObject({ spaceMuted: true });
    expect(snap[`${SPACE}:${BOT}:${VOICE_B}`]).toBeUndefined();
  });

  it('comes back when the bot takes the seat again, and an unmute lifts it', async () => {
    const { cm, handleClientEvent } = await seated();
    handleClientEvent({ type: 'voice_space_deafen', userId: BOT, channelId: VOICE_B, deafened: true }, 'owner', 'owner', ws, false);
    handleClientEvent({ type: 'bot_voice_leave', channelId: VOICE_B }, BOT, 'bot', ws, false);

    const sendToSpace = vi.spyOn(cm, 'sendToSpace');
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_B }, BOT, 'bot', ws, false);
    expect(sentOfType(sendToSpace, 'voice_space_deafened')).toEqual([
      { type: 'voice_space_deafened', userId: BOT, channelId: VOICE_B, spaceId: SPACE, deafened: true, botSeat: true },
    ]);

    handleClientEvent({ type: 'voice_space_deafen', userId: BOT, channelId: VOICE_B, deafened: false }, 'owner', 'owner', ws, false);
    expect(seatRows()).toEqual([]);
  });

  it('refuses a moderator without the bit in that channel', async () => {
    const now = Date.now();
    testDb.insert(schema.users).values({ id: 'p1', username: 'p1', passwordHash: 'x', homeUserId: 'p1', homeInstance: null, createdAt: now }).run();
    testDb.insert(schema.spaceMembers).values({ spaceId: SPACE, userId: 'p1', joinedAt: now }).run();
    const { cm, handleClientEvent } = await seated();
    const sendToUser = vi.spyOn(cm, 'sendToUser');

    handleClientEvent({ type: 'voice_space_mute', userId: BOT, channelId: VOICE_A, muted: true }, 'p1', 'p1', ws, false);

    expect(sendToUser).toHaveBeenCalledWith('p1', expect.objectContaining({ type: 'error', message: 'Missing MUTE_MEMBERS permission' }));
    expect(seatRows()).toEqual([]);
  });

  it('disconnects the seat in the named channel and keeps the other', async () => {
    const { cm, handleClientEvent } = await seated();
    const sendToUser = vi.spyOn(cm, 'sendToUser');

    handleClientEvent({ type: 'voice_disconnect', userId: BOT, channelId: VOICE_A }, 'owner', 'owner', ws, false);

    expect(cm.getBotRoomIds(BOT)).toEqual([VOICE_B]);
    expect(sendToUser).toHaveBeenCalledWith(BOT, { type: 'voice_disconnected', userId: BOT, channelId: VOICE_A });
  });

  it('a seat restriction goes when the bot is taken out of the space', async () => {
    const { handleClientEvent } = await seated();
    handleClientEvent({ type: 'voice_space_mute', userId: BOT, channelId: VOICE_A, muted: true }, 'owner', 'owner', ws, false);
    const { removeUserFromSpace } = await import('../utils/spaceMembership.js');
    removeUserFromSpace(SPACE, BOT);
    expect(seatRows()).toEqual([]);
  });
});
