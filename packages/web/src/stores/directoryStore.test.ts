import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DirectoryEntry, DirectoryFeed } from '@backspace/shared';
import { HttpError } from '../api/client';

// ── Home-instance API: only the directory proxy is exercised here ───────────
const directoryList = vi.fn(async (_q?: string, _limit?: number, _offset?: number): Promise<DirectoryFeed> => ({
  schema: 1,
  spaces: [],
}));

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: {
    directory: {
      list: (q?: string, limit?: number, offset?: number) => directoryList(q, limit, offset),
    },
  },
}));

// ── instanceStore: the connection list plus the two connect entry points ────
const session: { instances: { origin: string; status: string }[] } = { instances: [] };
const connectToInstance = vi.fn(async (_origin: string, _password: string, _displayName?: string) =>
  ({ kind: 'connected', how: 'new' }) as const,
);
const loginToRemote = vi.fn(async (_origin: string, _username: string, _password: string) => {});
const connectToRemote = vi.fn(async (_origin: string, _password: string, _displayName?: string) => {});
const reauthenticateInstance = vi.fn(async (_origin: string, _password: string) => {});

vi.mock('./instanceStore', () => ({
  useInstanceStore: {
    getState: () => ({ instances: session.instances, loginToRemote, connectToRemote, reauthenticateInstance }),
    subscribe: () => () => {},
  },
  connectToInstance: (origin: string, password: string, displayName?: string) =>
    connectToInstance(origin, password, displayName),
}));

// ── exploreStore: the join step ─────────────────────────────────────────────
const publicJoin = vi.fn(async (space: { id: string }) => ({ id: space.id, name: 'Joined' }));
const requestJoin = vi.fn(async (space: { id: string }, _message?: string) => ({ id: 'r1', spaceId: space.id, status: 'pending' }));
const fetchMyRequests = vi.fn(async () => {});

vi.mock('./exploreStore', () => ({
  useExploreStore: {
    getState: () => ({ publicJoin, requestJoin, fetchMyRequests }),
  },
}));

import { useDirectoryStore } from './directoryStore';

const PAGE = 50;

function entry(origin: string, id: string, visibility: 'public' | 'request' = 'public'): DirectoryEntry {
  return {
    origin,
    id,
    name: `Space ${id}`,
    description: null,
    icon: null,
    banner: null,
    avatarColor: null,
    visibility,
    memberCount: 3,
    createdAt: 1,
    instanceName: origin,
    federatedRegistrationOpen: true,
  };
}

function fullPage(origin: string, from: number): DirectoryEntry[] {
  return Array.from({ length: PAGE }, (_, i) => entry(origin, `s${from + i}`));
}

function httpError(code: string, status = 400): HttpError {
  return new HttpError(status, code, { error: code, code, statusCode: status }, code as HttpError['code']);
}

beforeEach(() => {
  directoryList.mockReset();
  directoryList.mockResolvedValue({ schema: 1, spaces: [] });
  connectToInstance.mockReset();
  connectToInstance.mockResolvedValue({ kind: 'connected', how: 'new' });
  loginToRemote.mockReset();
  loginToRemote.mockResolvedValue(undefined);
  connectToRemote.mockReset();
  reauthenticateInstance.mockReset();
  publicJoin.mockReset();
  publicJoin.mockImplementation(async (space: { id: string }) => ({ id: space.id, name: 'Joined' }));
  requestJoin.mockReset();
  requestJoin.mockImplementation(async (space: { id: string }) => ({ id: 'r1', spaceId: space.id, status: 'pending' }));
  fetchMyRequests.mockReset();
  fetchMyRequests.mockResolvedValue(undefined);
  session.instances = [];
  useDirectoryStore.getState().reset();
  Object.defineProperty(window, 'location', {
    value: new URL('https://nova.example/'),
    writable: true,
  });
});

describe('directoryStore.fetch', () => {
  it('asks the proxy for the first page and stores it as ok', async () => {
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: [entry('https://a.test', '1'), entry('https://b.test', '2')] });

    await useDirectoryStore.getState().fetch('');

    expect(directoryList).toHaveBeenCalledWith('', PAGE, 0);
    const state = useDirectoryStore.getState();
    expect(state.status).toBe('ok');
    expect(state.entries.map((e) => e.id)).toEqual(['1', '2']);
    expect(state.offset).toBe(0);
    expect(state.hasMore).toBe(false);
  });

  it('drops entries from the home origin and from every known instance, whatever its status', async () => {
    session.instances = [
      { origin: 'https://orbit.example', status: 'connected' },
      { origin: 'https://zeta.example', status: 'error' },
    ];
    directoryList.mockResolvedValueOnce({
      schema: 1,
      spaces: [
        entry('https://nova.example', 'home'),
        entry('https://orbit.example/', 'orbit'),
        entry('https://ZETA.example', 'zeta'),
        entry('https://far.example', 'far'),
      ],
    });

    await useDirectoryStore.getState().fetch('');

    expect(useDirectoryStore.getState().entries.map((e) => e.id)).toEqual(['far']);
  });

  it('marks hasMore when a full page came back', async () => {
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: fullPage('https://a.test', 0) });

    await useDirectoryStore.getState().fetch('');

    expect(useDirectoryStore.getState().hasMore).toBe(true);
  });

  it('maps directory_disabled to the disabled status', async () => {
    directoryList.mockRejectedValueOnce(httpError('directory_disabled', 404));

    await useDirectoryStore.getState().fetch('');

    expect(useDirectoryStore.getState().status).toBe('disabled');
    expect(useDirectoryStore.getState().entries).toEqual([]);
  });

  it('maps directory_unreachable to the unreachable status', async () => {
    directoryList.mockRejectedValueOnce(httpError('directory_unreachable', 502));

    await useDirectoryStore.getState().fetch('');

    expect(useDirectoryStore.getState().status).toBe('unreachable');
  });

  it('maps any other failure to error', async () => {
    directoryList.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await useDirectoryStore.getState().fetch('');

    expect(useDirectoryStore.getState().status).toBe('error');
  });

  it('is loading while the request is in flight and records the query', async () => {
    let release: (feed: DirectoryFeed) => void = () => {};
    directoryList.mockReturnValueOnce(new Promise<DirectoryFeed>((resolve) => { release = resolve; }));

    const pending = useDirectoryStore.getState().fetch('games');
    expect(useDirectoryStore.getState().status).toBe('loading');
    expect(useDirectoryStore.getState().query).toBe('games');

    release({ schema: 1, spaces: [] });
    await pending;
    expect(useDirectoryStore.getState().status).toBe('ok');
    expect(directoryList).toHaveBeenCalledWith('games', PAGE, 0);
  });

  it('replaces the entries and resets the offset on a new query', async () => {
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: fullPage('https://a.test', 0) });
    await useDirectoryStore.getState().fetch('');
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: fullPage('https://a.test', PAGE) });
    await useDirectoryStore.getState().loadMore();
    expect(useDirectoryStore.getState().offset).toBe(PAGE);
    expect(useDirectoryStore.getState().entries).toHaveLength(2 * PAGE);

    directoryList.mockResolvedValueOnce({ schema: 1, spaces: [entry('https://b.test', 'only')] });
    await useDirectoryStore.getState().fetch('only');

    const state = useDirectoryStore.getState();
    expect(state.offset).toBe(0);
    expect(state.query).toBe('only');
    expect(state.entries.map((e) => e.id)).toEqual(['only']);
  });

  it('ignores a stale reply that lands after a newer query', async () => {
    let releaseFirst: (feed: DirectoryFeed) => void = () => {};
    directoryList.mockReturnValueOnce(new Promise<DirectoryFeed>((resolve) => { releaseFirst = resolve; }));
    const first = useDirectoryStore.getState().fetch('a');

    directoryList.mockResolvedValueOnce({ schema: 1, spaces: [entry('https://b.test', 'b')] });
    await useDirectoryStore.getState().fetch('b');

    releaseFirst({ schema: 1, spaces: [entry('https://a.test', 'a')] });
    await first;

    expect(useDirectoryStore.getState().entries.map((e) => e.id)).toEqual(['b']);
    expect(useDirectoryStore.getState().status).toBe('ok');
  });
});

describe('directoryStore.loadMore', () => {
  it('requests the next page and appends without duplicates by (origin, id)', async () => {
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: fullPage('https://a.test', 0) });
    await useDirectoryStore.getState().fetch('');

    // The second page overlaps the first by one entry on the same origin and
    // carries the same id from another origin, which is a distinct space.
    directoryList.mockResolvedValueOnce({
      schema: 1,
      spaces: [entry('https://a.test', 's0'), entry('https://b.test', 's0'), entry('https://a.test', 'new')],
    });
    await useDirectoryStore.getState().loadMore();

    expect(directoryList).toHaveBeenLastCalledWith('', PAGE, PAGE);
    const state = useDirectoryStore.getState();
    expect(state.entries).toHaveLength(PAGE + 2);
    expect(state.entries.filter((e) => e.id === 's0').map((e) => e.origin)).toEqual(['https://a.test', 'https://b.test']);
    expect(state.offset).toBe(PAGE);
    expect(state.hasMore).toBe(false);
    expect(state.status).toBe('ok');
  });

  it('carries the current query into the next page', async () => {
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: fullPage('https://a.test', 0) });
    await useDirectoryStore.getState().fetch('games');
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: [] });

    await useDirectoryStore.getState().loadMore();

    expect(directoryList).toHaveBeenLastCalledWith('games', PAGE, PAGE);
  });

  it('does nothing when there is no further page', async () => {
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: [entry('https://a.test', '1')] });
    await useDirectoryStore.getState().fetch('');
    directoryList.mockClear();

    await useDirectoryStore.getState().loadMore();

    expect(directoryList).not.toHaveBeenCalled();
  });

  it('keeps the loaded entries when the next page fails', async () => {
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: fullPage('https://a.test', 0) });
    await useDirectoryStore.getState().fetch('');
    directoryList.mockRejectedValueOnce(httpError('directory_unreachable', 502));

    await useDirectoryStore.getState().loadMore();

    expect(useDirectoryStore.getState().status).toBe('unreachable');
    expect(useDirectoryStore.getState().entries).toHaveLength(PAGE);
    expect(useDirectoryStore.getState().offset).toBe(0);
  });
});

describe('directoryStore.connectAndJoin', () => {
  const ORIGIN = 'https://far.example';

  async function seed(...entries: DirectoryEntry[]) {
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: entries });
    await useDirectoryStore.getState().fetch('');
  }

  it('connects, joins a public space and removes the entry', async () => {
    const target = entry(ORIGIN, 'pub');
    await seed(target, entry('https://other.example', 'keep'));

    const result = await useDirectoryStore.getState().connectAndJoin(target, 'home-pw');

    expect(connectToInstance).toHaveBeenCalledWith(ORIGIN, 'home-pw', undefined);
    expect(publicJoin).toHaveBeenCalledWith({ ...target, _instanceOrigin: ORIGIN, joined: false });
    expect(requestJoin).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'joined', spaceId: 'pub', origin: ORIGIN });
    expect(useDirectoryStore.getState().entries.map((e) => e.id)).toEqual(['keep']);
    expect(fetchMyRequests).toHaveBeenCalledOnce();
  });

  it('connects and requests to join a request space with the message', async () => {
    const target = entry(ORIGIN, 'req', 'request');
    await seed(target);

    const result = await useDirectoryStore.getState().connectAndJoin(target, 'home-pw', 'hello there');

    expect(connectToInstance).toHaveBeenCalledWith(ORIGIN, 'home-pw', undefined);
    expect(requestJoin).toHaveBeenCalledWith({ ...target, _instanceOrigin: ORIGIN, joined: false }, 'hello there');
    expect(publicJoin).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'requested' });
    expect(useDirectoryStore.getState().entries).toEqual([]);
  });

  it('joins straight away when the origin is connected already, without a new session', async () => {
    const target = entry(ORIGIN, 'pub');
    await seed(target);
    // The card went stale: the user connected this origin through the
    // Connections panel after Outer Space was loaded.
    session.instances = [{ origin: ORIGIN, status: 'connected' }];
    connectToInstance.mockResolvedValueOnce({ kind: 'connected', how: 'already' });

    const result = await useDirectoryStore.getState().connectAndJoin(target, 'home-pw');

    expect(result).toEqual({ kind: 'joined', spaceId: 'pub', origin: ORIGIN });
    expect(publicJoin).toHaveBeenCalledWith({ ...target, _instanceOrigin: ORIGIN, joined: false });
    expect(connectToRemote).not.toHaveBeenCalled();
    expect(reauthenticateInstance).not.toHaveBeenCalled();
    expect(useDirectoryStore.getState().entries).toEqual([]);
  });

  it('treats already_member from the join as joined', async () => {
    const target = entry(ORIGIN, 'pub');
    await seed(target);
    publicJoin.mockRejectedValueOnce(httpError('already_member', 409));

    const result = await useDirectoryStore.getState().connectAndJoin(target, 'home-pw');

    expect(result).toEqual({ kind: 'joined', spaceId: 'pub', origin: ORIGIN });
    expect(useDirectoryStore.getState().entries).toEqual([]);
  });

  it('returns needs-remote-password as is without joining', async () => {
    const target = entry(ORIGIN, 'pub');
    await seed(target);
    connectToInstance.mockResolvedValueOnce({ kind: 'needs-remote-password', remoteUsername: 'erin@nova.example' });

    const result = await useDirectoryStore.getState().connectAndJoin(target, 'home-pw');

    expect(result).toEqual({ kind: 'needs-remote-password', remoteUsername: 'erin@nova.example' });
    expect(publicJoin).not.toHaveBeenCalled();
    expect(requestJoin).not.toHaveBeenCalled();
    expect(fetchMyRequests).not.toHaveBeenCalled();
    expect(useDirectoryStore.getState().entries).toHaveLength(1);
  });

  it('rethrows a connect failure and keeps the entry', async () => {
    const target = entry(ORIGIN, 'pub');
    await seed(target);
    connectToInstance.mockRejectedValueOnce(new Error('Incorrect password'));

    await expect(useDirectoryStore.getState().connectAndJoin(target, 'wrong')).rejects.toThrow('Incorrect password');
    expect(publicJoin).not.toHaveBeenCalled();
    expect(useDirectoryStore.getState().entries).toHaveLength(1);
  });

  it('rethrows a join failure that is not already_member', async () => {
    const target = entry(ORIGIN, 'pub');
    await seed(target);
    publicJoin.mockRejectedValueOnce(httpError('space_not_found', 404));

    await expect(useDirectoryStore.getState().connectAndJoin(target, 'home-pw')).rejects.toBeInstanceOf(HttpError);
  });

  it('removes every entry of the origin once it is connected, not only the joined one', async () => {
    const target = entry(ORIGIN, 'pub');
    await seed(target, entry(ORIGIN, 'sibling'), entry('https://other.example', 'keep'));

    await useDirectoryStore.getState().connectAndJoin(target, 'home-pw');

    expect(useDirectoryStore.getState().entries.map((e) => e.id)).toEqual(['keep']);
  });
});

describe('directoryStore.loginAndJoin', () => {
  const ORIGIN = 'https://far.example';

  it('logs in with the remote password and then joins a public space', async () => {
    const target = entry(ORIGIN, 'pub');
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: [target] });
    await useDirectoryStore.getState().fetch('');

    const result = await useDirectoryStore.getState().loginAndJoin(target, 'erin@nova.example', 'remote-pw');

    expect(loginToRemote).toHaveBeenCalledWith(ORIGIN, 'erin@nova.example', 'remote-pw');
    expect(connectToInstance).not.toHaveBeenCalled();
    expect(publicJoin).toHaveBeenCalledWith({ ...target, _instanceOrigin: ORIGIN, joined: false });
    expect(result).toEqual({ kind: 'joined', spaceId: 'pub', origin: ORIGIN });
    expect(useDirectoryStore.getState().entries).toEqual([]);
    expect(fetchMyRequests).toHaveBeenCalledOnce();
  });

  it('logs in and then requests to join a request space with the message', async () => {
    const target = entry(ORIGIN, 'req', 'request');

    const result = await useDirectoryStore.getState().loginAndJoin(target, 'erin@nova.example', 'remote-pw', 'let me in');

    expect(loginToRemote).toHaveBeenCalledWith(ORIGIN, 'erin@nova.example', 'remote-pw');
    expect(requestJoin).toHaveBeenCalledWith({ ...target, _instanceOrigin: ORIGIN, joined: false }, 'let me in');
    expect(result).toEqual({ kind: 'requested' });
  });

  it('rethrows a login failure without joining', async () => {
    const target = entry(ORIGIN, 'pub');
    loginToRemote.mockRejectedValueOnce(new Error('Invalid credentials'));

    await expect(useDirectoryStore.getState().loginAndJoin(target, 'erin', 'bad')).rejects.toThrow('Invalid credentials');
    expect(publicJoin).not.toHaveBeenCalled();
  });
});

describe('directoryStore.reset', () => {
  it('returns to the idle state', async () => {
    directoryList.mockResolvedValueOnce({ schema: 1, spaces: fullPage('https://a.test', 0) });
    await useDirectoryStore.getState().fetch('games');

    useDirectoryStore.getState().reset();

    const state = useDirectoryStore.getState();
    expect(state.entries).toEqual([]);
    expect(state.status).toBe('idle');
    expect(state.query).toBe('');
    expect(state.offset).toBe(0);
    expect(state.hasMore).toBe(false);
  });
});
