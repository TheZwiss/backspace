import { describe, it, expect, beforeEach, vi } from 'vitest';

const homeSendRequest = vi.fn(async () => ({ success: true, requestId: 'req-1' }));
const homeRequests = vi.fn(async () => []);

vi.mock('../api/client', () => ({
  api: {
    social: {
      sendRequest: (...args: unknown[]) => homeSendRequest(...args),
      requests: () => homeRequests(),
    },
  },
}));

vi.mock('../utils/assetUrls', () => ({
  normalizeUserAssets: (u: unknown) => u,
}));

// instanceStore is still imported by other socialStore methods (loadFriends, loadRequests)
// — provide an empty-instances stub so those calls don't crash.
vi.mock('./instanceStore', () => ({
  useInstanceStore: {
    getState: () => ({ instances: [], _autoConnectDone: true }),
    subscribe: () => () => {},
  },
}));

import { useSocialStore } from './socialStore';

describe('socialStore.sendFriendRequest — server-side routing (post-S2S)', () => {
  beforeEach(() => {
    homeSendRequest.mockClear();
    homeRequests.mockClear();
  });

  it('sends bare handle to home API as-is', async () => {
    const id = await useSocialStore.getState().sendFriendRequest('bob');
    expect(homeSendRequest).toHaveBeenCalledOnce();
    expect(homeSendRequest).toHaveBeenCalledWith('bob');
    expect(id).toBe('req-1');
  });

  it('sends @-handle to home API verbatim (server handles routing)', async () => {
    await useSocialStore.getState().sendFriendRequest('bob@orbit.tld');
    expect(homeSendRequest).toHaveBeenCalledWith('bob@orbit.tld');
  });

  it('sends @-handle for own host to home API verbatim', async () => {
    await useSocialStore.getState().sendFriendRequest('bob@local.test');
    expect(homeSendRequest).toHaveBeenCalledWith('bob@local.test');
  });

  it('trims whitespace before sending', async () => {
    await useSocialStore.getState().sendFriendRequest('  bob  ');
    expect(homeSendRequest).toHaveBeenCalledWith('bob');
  });

  it('propagates server errors and sets store.error', async () => {
    homeSendRequest.mockRejectedValueOnce(new Error('user_not_found'));
    await expect(useSocialStore.getState().sendFriendRequest('nope')).rejects.toThrow('user_not_found');
    expect(useSocialStore.getState().error).toBe('user_not_found');
  });
});
