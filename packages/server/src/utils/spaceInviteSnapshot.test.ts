import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchSpaceInviteSnapshot } from './spaceInviteSnapshot';

describe('fetchSpaceInviteSnapshot', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn() as any; });
  afterEach(() => { global.fetch = originalFetch; });

  it('returns snapshot when preview endpoint succeeds', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        spaceId: 'S1',
        spaceName: 'Aether',
        description: 'desc',
        icon: null,
        avatarColor: 'mint',
        memberCount: 12,
        instanceName: 'Backspace',
      }),
    });
    const snap = await fetchSpaceInviteSnapshot('https://z.example', 'abc123');
    expect(snap).toEqual({
      spaceId: 'S1',
      spaceName: 'Aether',
      description: 'desc',
      icon: null,
      avatarColor: 'mint',
      memberCount: 12,
      instanceName: 'Backspace',
    });
  });

  it('returns null when preview returns 404', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const snap = await fetchSpaceInviteSnapshot('https://z.example', 'badcode');
    expect(snap).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const snap = await fetchSpaceInviteSnapshot('https://z.example', 'abc123');
    expect(snap).toBeNull();
  });

  it('aborts after timeout', async () => {
    (global.fetch as any).mockImplementationOnce((_url: string, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const snap = await fetchSpaceInviteSnapshot('https://z.example', 'abc', 50);
    expect(snap).toBeNull();
  });
});
