import { afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { livekitRoutes } from './livekit.js';

vi.mock('../config.js', () => ({ config: { livekit: {
  apiKey: 'local-test-key', apiSecret: 'local-test-secret-long-enough',
  url: 'ws://127.0.0.1:7880', autoUrl: true,
} } }));
vi.mock('../utils/auth.js', () => ({ authenticate: async (request: { userId: string; username: string }) => {
  request.userId = 'local-test-user'; request.username = 'local-test';
} }));
vi.mock('../utils/permissions.js', () => ({
  PermissionBits: { SPEAK: 1n, STREAM: 2n, ADMINISTRATOR: 4n },
  getChannelSpaceId: () => 'space', hasPermission: () => true,
  computePermissions: () => 0n, isDmMember: () => false,
}));
vi.mock('../db/index.js', () => ({ getDb: () => ({}) }));

const app = Fastify({ trustProxy: true });
await app.register(livekitRoutes);
await app.ready();
afterAll(async () => { await app.close(); });

describe('LiveKit signaling through PRoot reverse proxies', () => {
  it.each([
    ['10.0.1.5:8443', 'wss://10.0.1.5:8443/livekit/'],
    ['100.113.4.54:8443', 'wss://100.113.4.54:8443/livekit/'],
    ['backspace.example.ts.net', 'wss://backspace.example.ts.net/livekit/'],
  ])('returns the connecting HTTPS host %s', async (host, expected) => {
    const res = await app.inject({ method: 'POST', url: '/api/livekit/token',
      headers: { host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' },
      payload: { channelId: 'voice' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().url).toBe(expected);
  });

  it('keeps the configured URL for direct requests', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/livekit/token',
      headers: { host: '127.0.0.1:3005' }, payload: { channelId: 'voice' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().url).toBe('ws://127.0.0.1:7880');
  });
});
