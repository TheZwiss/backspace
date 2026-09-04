import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from '../db/schema.js';
import { searchRoutes } from './search.js';
import { livekitRoutes } from './livekit.js';
import { uploadRoutes } from './uploads.js';
import { gifRoutes } from './gif.js';
import { utilRoutes } from './utils.js';

/**
 * Every user-visible error these routes send must carry a stable `code`
 * (see packages/shared/src/errors.ts) so the client can localize it. The
 * routes are exercised through their guards only; the happy paths have
 * their own tests elsewhere.
 */

const permissionMocks = vi.hoisted(() => ({
  getChannelSpaceId: vi.fn<(id: string) => string | null>(),
  hasPermission: vi.fn<() => boolean>(),
  computePermissions: vi.fn<() => bigint>(() => 0n),
  isDmMember: vi.fn<() => boolean>(),
}));

const state = vi.hoisted(() => ({
  dbRow: undefined as unknown,
  uploadDir: '',
  livekit: { apiKey: '', apiSecret: '', url: '' },
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (request: { userId?: string; username?: string }) => {
    request.userId = 'user-1';
    request.username = 'alice';
  },
}));

vi.mock('../utils/permissions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/permissions.js')>();
  return {
    ...real,
    getChannelSpaceId: permissionMocks.getChannelSpaceId,
    hasPermission: permissionMocks.hasPermission,
    computePermissions: permissionMocks.computePermissions,
    isDmMember: permissionMocks.isDmMember,
  };
});

vi.mock('../db/index.js', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin']) {
    chain[name] = () => chain;
  }
  chain.get = () => state.dbRow;
  chain.all = () => [];
  return { getDb: () => chain, getRawDb: () => ({}), schema };
});

vi.mock('../config.js', () => ({
  config: {
    get uploadDir() { return state.uploadDir; },
    get livekit() { return state.livekit; },
  },
}));

vi.mock('./messages.js', () => ({
  fetchReactionsForMessages: () => new Map(),
  fetchReplyToMessages: () => new Map(),
  buildMessageWithUser: (m: unknown) => m,
}));
vi.mock('./dm.js', () => ({
  fetchDmReactionsForMessages: () => new Map(),
  fetchDmReplyToMessages: () => new Map(),
  buildDmMessageWithUser: (m: unknown) => m,
}));
vi.mock('../utils/embedResolver.js', () => ({
  fetchEmbedsForMessages: () => new Map(),
  fetchDmEmbedsForMessages: () => new Map(),
}));
vi.mock('../utils/metadataFetcher.js', () => ({
  fetchUrlMetadata: async () => null,
}));

const auth = { authorization: 'Bearer test' };

let app: FastifyInstance;

beforeEach(async () => {
  state.dbRow = undefined;
  state.uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-uploads-'));
  state.livekit = { apiKey: '', apiSecret: '', url: '' };
  permissionMocks.getChannelSpaceId.mockReset();
  permissionMocks.hasPermission.mockReset();
  permissionMocks.isDmMember.mockReset();
  permissionMocks.computePermissions.mockReset().mockReturnValue(0n);
  app = Fastify();
  await app.register(searchRoutes);
  await app.register(livekitRoutes);
  await app.register(uploadRoutes);
  await app.register(gifRoutes);
  await app.register(utilRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(state.uploadDir, { recursive: true, force: true });
});

describe('search routes send error codes', () => {
  it('channel search: unknown channel', async () => {
    permissionMocks.getChannelSpaceId.mockReturnValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/channels/c1/search?q=x', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'channel_not_found', error: 'Channel not found', statusCode: 404 });
  });

  it('channel search: missing permission', async () => {
    permissionMocks.getChannelSpaceId.mockReturnValue('space-1');
    permissionMocks.hasPermission.mockReturnValue(false);
    const res = await app.inject({ method: 'GET', url: '/api/channels/c1/search?q=x', headers: auth });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'missing_permission', error: 'Missing READ_MESSAGE_HISTORY permission' });
  });

  it('dm search: not a member', async () => {
    permissionMocks.isDmMember.mockReturnValue(false);
    const res = await app.inject({ method: 'GET', url: '/api/dm/d1/search?q=x', headers: auth });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'not_dm_member', error: 'You are not a member of this DM channel' });
  });

  it('channel around: messageId missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/channels/c1/messages/around', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('channel around: message not found', async () => {
    permissionMocks.getChannelSpaceId.mockReturnValue('space-1');
    permissionMocks.hasPermission.mockReturnValue(true);
    state.dbRow = undefined;
    const res = await app.inject({ method: 'GET', url: '/api/channels/c1/messages/around?messageId=m1', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'message_not_found', error: 'Message not found' });
  });

  it('dm around: messageId missing, then not a member, then message not found', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/dm/d1/messages/around', headers: auth });
    expect(res.json()).toMatchObject({ statusCode: 400, code: 'validation_failed' });

    permissionMocks.isDmMember.mockReturnValue(false);
    res = await app.inject({ method: 'GET', url: '/api/dm/d1/messages/around?messageId=m1', headers: auth });
    expect(res.json()).toMatchObject({ statusCode: 403, code: 'not_dm_member' });

    permissionMocks.isDmMember.mockReturnValue(true);
    res = await app.inject({ method: 'GET', url: '/api/dm/d1/messages/around?messageId=m1', headers: auth });
    expect(res.json()).toMatchObject({ statusCode: 404, code: 'message_not_found' });
  });
});

describe('livekit token route sends error codes', () => {
  it('voice not configured', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/livekit/token', headers: auth, payload: { channelId: 'c1' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'voice_disabled', error: 'Voice/video is not configured on this server' });
  });

  it('dm call: not a member', async () => {
    state.livekit = { apiKey: 'k', apiSecret: 's', url: 'ws://lk' };
    permissionMocks.isDmMember.mockReturnValue(false);
    const res = await app.inject({ method: 'POST', url: '/api/livekit/token', headers: auth, payload: { dmChannelId: 'd1' } });
    expect(res.json()).toMatchObject({ statusCode: 403, code: 'not_dm_member' });
  });

  it('space voice: unknown channel, then no CONNECT permission', async () => {
    state.livekit = { apiKey: 'k', apiSecret: 's', url: 'ws://lk' };
    permissionMocks.getChannelSpaceId.mockReturnValue(null);
    let res = await app.inject({ method: 'POST', url: '/api/livekit/token', headers: auth, payload: { channelId: 'c1' } });
    expect(res.json()).toMatchObject({ statusCode: 404, code: 'channel_not_found' });

    permissionMocks.getChannelSpaceId.mockReturnValue('space-1');
    permissionMocks.hasPermission.mockReturnValue(false);
    res = await app.inject({ method: 'POST', url: '/api/livekit/token', headers: auth, payload: { channelId: 'c1' } });
    expect(res.json()).toMatchObject({ statusCode: 403, code: 'voice_connect_forbidden', error: 'Missing CONNECT permission' });
  });

  it('neither channel id given', async () => {
    state.livekit = { apiKey: 'k', apiSecret: 's', url: 'ws://lk' };
    const res = await app.inject({ method: 'POST', url: '/api/livekit/token', headers: auth, payload: {} });
    expect(res.json()).toMatchObject({ statusCode: 400, code: 'validation_failed' });
  });
});

describe('upload, gif and util routes send error codes', () => {
  it('serving a file that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/uploads/missing.png' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'file_not_found', error: 'File not found' });
  });

  it('gif search without a query', async () => {
    state.dbRow = { gifApiKey: 'klipy-key' };
    const res = await app.inject({ method: 'GET', url: '/api/gif/search', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('metadata without a url', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/utils/metadata', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed', statusCode: 400 });
  });
});
