import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DmChannel, User } from '@backspace/shared';

/**
 * Owner-only group DM requests go to the owner's home instance, so the relay
 * event they cause comes from the instance receivers accept it from. A
 * request to an instance names the conversation, and the member it acts on,
 * as that instance's own copy does: the copy the client shows may be another
 * instance's, whose ids mean nothing there.
 */

vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
vi.mock('../stores/instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ instances: [], _autoConnectDone: true }),
    { getState: () => ({ instances: [], _autoConnectDone: true }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    { getState: () => ({ user: null, token: null }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

const ORBIT = 'https://orbit.test';

const { clients, mockGetApiForOrigin, connected } = vi.hoisted(() => {
  const make = () => ({
    dm: {
      updateMetadata: vi.fn().mockResolvedValue({}),
      kickMember: vi.fn().mockResolvedValue({ success: true }),
      transferOwnership: vi.fn().mockResolvedValue({}),
    },
  });
  const all = { home: make(), orbit: make() };
  const hosts = new Map<string, string>();
  return {
    clients: all,
    connected: hosts,
    mockGetApiForOrigin: vi.fn((origin: string) => (origin ? all.orbit : all.home) as never),
  };
});

vi.mock('./crossStoreResolvers', async () => {
  const actual = await vi.importActual<typeof import('./crossStoreResolvers')>('./crossStoreResolvers');
  return {
    ...actual,
    getApiForOrigin: mockGetApiForOrigin,
    resolveOriginFromHostname: (host: string) => connected.get(host) ?? '',
  };
});

import { useSpaceStore } from '../stores/spaceStore';
import { kickFromGroupDm, OwnerInstanceUnavailableError, transferGroupDmOwnership, updateGroupDmMetadata } from './groupDmOwnerActions';

const HOME_HOST = window.location.host;

function member(id: string, fields: Partial<User> = {}): User {
  return {
    id, username: id, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 0,
    homeUserId: null, homeInstance: null, replicatedInstances: [], ...fields,
  };
}

function copy(id: string, ownerHomeInstance: string, members: User[]): DmChannel {
  return {
    id, federatedId: 'group-key', ownerId: 'owner', ownerHomeUserId: 'owner-home', ownerHomeInstance,
    name: null, icon: null, metadataUpdatedAt: 0, createdAt: 1, members, lastMessage: null,
  };
}

const bobOnHome = member('bob');
const carolOnHome = member('carol-stub', { username: 'carol@orbit.test', homeUserId: 'carol', homeInstance: 'orbit.test' });

beforeEach(() => {
  vi.clearAllMocks();
  connected.clear();
  useSpaceStore.getState().reset();
});

describe('owner on another instance, the home copy shown', () => {
  beforeEach(() => {
    connected.set('orbit.test', ORBIT);
    // The home copy is pinned; orbit holds its own copy under its own id.
    useSpaceStore.getState().populateFromReady('', [], [], [copy('dm-home', ORBIT, [bobOnHome, carolOnHome])]);
    useSpaceStore.getState().populateFromReady(ORBIT, [], [], [copy('dm-orbit', ORBIT, [])]);
  });

  it('a rename names orbit\'s copy', async () => {
    await updateGroupDmMetadata('dm-home', { name: 'Crew' });
    expect(mockGetApiForOrigin).toHaveBeenCalledWith(ORBIT);
    expect(clients.orbit.dm.updateMetadata).toHaveBeenCalledWith('dm-orbit', { name: 'Crew' });
    expect(clients.home.dm.updateMetadata).not.toHaveBeenCalled();
  });

  it('a kick names a member native to the shown instance by that instance\'s identity', async () => {
    await kickFromGroupDm('dm-home', bobOnHome);
    expect(clients.orbit.dm.kickMember).toHaveBeenCalledWith('dm-orbit', { homeUserId: 'bob', homeInstance: HOME_HOST });
  });

  it('a transfer names a member homed elsewhere by their home identity', async () => {
    await transferGroupDmOwnership('dm-home', carolOnHome);
    expect(clients.orbit.dm.transferOwnership).toHaveBeenCalledWith('dm-orbit', { homeUserId: 'carol', homeInstance: 'orbit.test' });
  });
});

describe('owner on the shown copy\'s instance', () => {
  beforeEach(() => {
    useSpaceStore.getState().populateFromReady('', [], [], [copy('dm-home', `http://${HOME_HOST}`, [bobOnHome, carolOnHome])]);
  });

  it('a kick of a local member names them by the local id', async () => {
    await kickFromGroupDm('dm-home', bobOnHome);
    expect(mockGetApiForOrigin).toHaveBeenCalledWith('');
    expect(clients.home.dm.kickMember).toHaveBeenCalledWith('dm-home', { userId: 'bob' });
  });

  it('a kick of a member homed elsewhere names them by their home identity', async () => {
    await kickFromGroupDm('dm-home', carolOnHome);
    expect(clients.home.dm.kickMember).toHaveBeenCalledWith('dm-home', { homeUserId: 'carol', homeInstance: 'orbit.test' });
  });
});

describe('owner instance the client cannot reach', () => {
  it('not connected: refuses without sending anything anywhere', async () => {
    useSpaceStore.getState().populateFromReady('', [], [], [copy('dm-home', ORBIT, [bobOnHome])]);
    await expect(updateGroupDmMetadata('dm-home', { name: 'x' })).rejects.toBeInstanceOf(OwnerInstanceUnavailableError);
    expect(clients.home.dm.updateMetadata).not.toHaveBeenCalled();
    expect(clients.orbit.dm.updateMetadata).not.toHaveBeenCalled();
  });

  it('connected, but it lists no copy of the conversation: refuses', async () => {
    connected.set('orbit.test', ORBIT);
    useSpaceStore.getState().populateFromReady('', [], [], [copy('dm-home', ORBIT, [bobOnHome])]);
    await expect(kickFromGroupDm('dm-home', bobOnHome)).rejects.toBeInstanceOf(OwnerInstanceUnavailableError);
    expect(clients.orbit.dm.kickMember).not.toHaveBeenCalled();
  });
});
