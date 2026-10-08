import { describe, it, expect, beforeEach, vi } from 'vitest';

const { homeSendRequest, homeRequests, orbitSendRequest, friendsHome, ORBIT } = vi.hoisted(() => ({
  homeSendRequest: vi.fn<(...args: unknown[]) => Promise<{ success: boolean; requestId: string }>>(async () => ({ success: true, requestId: 'req-1' })),
  homeRequests: vi.fn(async () => []),
  orbitSendRequest: vi.fn<(...args: unknown[]) => Promise<{ success: boolean; requestId: string }>>(async () => ({ success: true, requestId: 'req-orbit' })),
  // The origin `getFriendsHomeOrigin` answers: '' for a native account.
  friendsHome: { origin: '' },
  ORBIT: 'https://orbit.tld',
}));

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

// orbit is connected but not listed as `connected` for the reload fan-out,
// so `loadRequests` after a send asks the page's instance only.
vi.mock('./instanceStore', () => ({
  useInstanceStore: {
    getState: () => ({
      instances: [{ origin: ORBIT, status: 'connecting', api: { social: { sendRequest: orbitSendRequest } } }],
      _autoConnectDone: true,
    }),
    subscribe: () => () => {},
  },
  waitForAutoConnect: async () => {},
  getFriendsHomeOrigin: () => friendsHome.origin,
}));

import { useSocialStore } from './socialStore';

describe('socialStore.sendFriendRequest — server-side routing (post-S2S)', () => {
  beforeEach(() => {
    homeSendRequest.mockClear();
    homeRequests.mockClear();
    orbitSendRequest.mockClear();
    friendsHome.origin = '';
  });

  it('sends bare handle to home API as-is', async () => {
    const id = await useSocialStore.getState().sendFriendRequest({ username: 'bob' });
    expect(homeSendRequest).toHaveBeenCalledOnce();
    expect(homeSendRequest).toHaveBeenCalledWith({ username: 'bob' });
    expect(id).toBe('req-1');
  });

  it('sends @-handle to home API verbatim (server handles routing)', async () => {
    await useSocialStore.getState().sendFriendRequest({ username: 'bob@orbit.tld' });
    expect(homeSendRequest).toHaveBeenCalledWith({ username: 'bob@orbit.tld' });
  });

  it('sends @-handle for own host to home API verbatim', async () => {
    await useSocialStore.getState().sendFriendRequest({ username: 'bob@local.test' });
    expect(homeSendRequest).toHaveBeenCalledWith({ username: 'bob@local.test' });
  });

  it('trims whitespace before sending', async () => {
    await useSocialStore.getState().sendFriendRequest({ username: '  bob  ' });
    expect(homeSendRequest).toHaveBeenCalledWith({ username: 'bob' });
  });

  it('sends an identity to the home API, with the username alongside', async () => {
    await useSocialStore.getState().sendFriendRequest({ username: 'yoko@orbit.tld', homeUserId: 'yoko-home', homeInstance: 'orbit.tld' });
    expect(homeSendRequest).toHaveBeenCalledWith({ username: 'yoko@orbit.tld', homeUserId: 'yoko-home', homeInstance: 'orbit.tld' });
  });

  it('propagates server errors and sets store.error', async () => {
    homeSendRequest.mockRejectedValueOnce(new Error('user_not_found'));
    await expect(useSocialStore.getState().sendFriendRequest({ username: 'nope' })).rejects.toThrow('user_not_found');
    expect(useSocialStore.getState().error).toBe('user_not_found');
  });
});

describe('socialStore.sendFriendRequest from a federated account', () => {
  beforeEach(() => {
    homeSendRequest.mockClear();
    orbitSendRequest.mockClear();
    // The page is signed in with a federated account whose home is orbit.
    friendsHome.origin = ORBIT;
  });

  it("sends to the user's home, not the page's instance, which refuses it", async () => {
    const id = await useSocialStore.getState().sendFriendRequest({ username: 'yoko@nova.tld', homeUserId: 'yoko-home', homeInstance: 'nova.tld' });
    expect(orbitSendRequest).toHaveBeenCalledWith({ username: 'yoko@nova.tld', homeUserId: 'yoko-home', homeInstance: 'nova.tld' });
    expect(homeSendRequest).not.toHaveBeenCalled();
    expect(id).toBe('req-orbit');
  });

  it("names a bare handle by the page's host, where the user typed it", async () => {
    await useSocialStore.getState().sendFriendRequest({ username: ' bob ' });
    expect(orbitSendRequest).toHaveBeenCalledWith({ username: `bob@${window.location.host}` });
  });

  it('sends a handle that names its host as typed', async () => {
    await useSocialStore.getState().sendFriendRequest({ username: 'bob@nova.tld' });
    expect(orbitSendRequest).toHaveBeenCalledWith({ username: 'bob@nova.tld' });
  });

  it('refuses when the home is an origin the client holds no entry for', async () => {
    friendsHome.origin = 'https://gone.tld';
    await expect(useSocialStore.getState().sendFriendRequest({ username: 'bob' })).rejects.toThrow('gone.tld');
    expect(orbitSendRequest).not.toHaveBeenCalled();
    expect(homeSendRequest).not.toHaveBeenCalled();
  });
});
