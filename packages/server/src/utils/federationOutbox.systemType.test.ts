import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://test.example',
  buildFederationHeaders: () => ({}),
  generateHmacSecret: () => 'secret',
}));

describe('buildRelayPayload — type field', () => {
  const user = { id: 'u1', homeUserId: 'u1', homeInstance: 'https://x.example' };

  it('omits type for user messages (backward-compat with old peers)', async () => {
    const { buildRelayPayload } = await import('./federationOutbox.js');
    const payload = buildRelayPayload(
      { id: 'm1', type: 'user', content: 'hi', createdAt: 1 },
      user,
    );
    expect((payload as any).type).toBeUndefined();
  });

  it('omits type when not set (defaults to user)', async () => {
    const { buildRelayPayload } = await import('./federationOutbox.js');
    const payload = buildRelayPayload(
      { id: 'm1', content: 'hi', createdAt: 1 },
      user,
    );
    expect((payload as any).type).toBeUndefined();
  });

  it('emits type for system messages', async () => {
    const { buildRelayPayload } = await import('./federationOutbox.js');
    const payload = buildRelayPayload(
      { id: 'm1', type: 'system', content: '{"event":"space_invite"}', createdAt: 1 },
      user,
    );
    expect((payload as any).type).toBe('system');
  });
});
