import { describe, it, expect, beforeEach, vi } from 'vitest';

const homeSendRequest = vi.fn(async () => ({ success: true, requestId: 'req-home' }));
const remoteSendRequest = vi.fn(async () => ({ success: true, requestId: 'req-remote' }));
const homeRequests = vi.fn(async () => []);
const remoteRequests = vi.fn(async () => []);

vi.mock('../api/client', () => ({
  api: {
    social: {
      sendRequest: (...args: unknown[]) => homeSendRequest(...args),
      requests: () => homeRequests(),
    },
  },
}));

const remoteApi = {
  social: {
    sendRequest: (...args: unknown[]) => remoteSendRequest(...args),
    requests: () => remoteRequests(),
  },
};

vi.mock('./instanceStore', () => ({
  useInstanceStore: {
    getState: () => ({
      instances: [
        {
          origin: 'https://orbit.ddns.net',
          status: 'connected',
          api: remoteApi,
        },
      ],
    }),
  },
}));

vi.mock('../utils/assetUrls', () => ({
  normalizeUserAssets: (u: unknown) => u,
}));

import { useSocialStore } from './socialStore';

describe('socialStore.sendFriendRequest — case-insensitive domain routing', () => {
  beforeEach(() => {
    homeSendRequest.mockClear();
    remoteSendRequest.mockClear();
    homeRequests.mockClear();
    remoteRequests.mockClear();
    // window.location.host in jsdom defaults to 'localhost:3000' or similar.
    // Override it for routing tests.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, host: 'local.test', hostname: 'local.test' },
    });
  });

  it('sends to the home API when the typed domain matches window.location.host exactly', async () => {
    await useSocialStore.getState().sendFriendRequest('bob@local.test');
    expect(homeSendRequest).toHaveBeenCalledWith('bob');
    expect(remoteSendRequest).not.toHaveBeenCalled();
  });

  it('sends to the home API when the typed domain matches with mixed case', async () => {
    await useSocialStore.getState().sendFriendRequest('bob@LOCAL.TEST');
    expect(homeSendRequest).toHaveBeenCalledWith('bob');
    expect(remoteSendRequest).not.toHaveBeenCalled();
  });

  it('routes to a connected remote instance when the typed domain matches its origin host', async () => {
    await useSocialStore.getState().sendFriendRequest('bob@orbit.ddns.net');
    expect(remoteSendRequest).toHaveBeenCalledWith('bob');
    expect(homeSendRequest).not.toHaveBeenCalled();
  });

  it('routes to a connected remote instance when the typed domain has mixed case', async () => {
    await useSocialStore.getState().sendFriendRequest('bob@ORBIT.ddns.net');
    expect(remoteSendRequest).toHaveBeenCalledWith('bob');
    expect(homeSendRequest).not.toHaveBeenCalled();
  });

  it('sends bare handle (no @) directly to the home API', async () => {
    await useSocialStore.getState().sendFriendRequest('bob');
    expect(homeSendRequest).toHaveBeenCalledWith('bob');
    expect(remoteSendRequest).not.toHaveBeenCalled();
  });
});
