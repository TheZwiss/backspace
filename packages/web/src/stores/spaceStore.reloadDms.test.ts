import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
  wsSendAll: vi.fn(),
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// The signed-in user: alice, native on the home instance.
vi.mock('./authStore', () => {
  const state = { user: { id: 'alice-home', username: 'alice', homeInstance: null, homeUserId: null }, token: 't' };
  return {
    useAuthStore: Object.assign(
      (selector: (s: unknown) => unknown) => selector(state),
      { getState: () => state, setState: vi.fn(), subscribe: vi.fn() },
    ),
  };
});

vi.mock('./instanceStore', async () => {
  const { create } = await import('zustand');
  const store = create<{ instances: unknown[] }>()(() => ({ instances: [] }));
  return { useInstanceStore: store };
});

import { useSpaceStore, setApiForOriginResolver } from './spaceStore';
import { useChatStore } from './chatStore';
import { api, type BackspaceApiClient } from '../api/client';
import { wireDm, asListedBy161, copyDm } from '../test/dmWireShape';
import type { DmChannel, User } from '@backspace/shared';

const REMOTE = 'https://remote.example';

// oneOnOneKey over 'alice-home' and 'bob-remote' on the server: the key both
// instances give the alice-bob conversation.
const FID_ALICE_BOB = 'fc8aa3239ccea0cd4cbfb7701d770ac9';
const FID_GROUP = '0e0e0e0e-0000-4000-8000-000000000000';

function user(id: string, homeUserId: string | null = null, homeInstance: string | null = null): User {
  return {
    id, username: id, displayName: null, avatar: null, avatarColor: null, status: 'online',
    createdAt: 1, homeInstance, homeUserId,
  } as User;
}

const aliceHome = user('alice-home');
const aliceOnRemote = user('alice-on-remote', 'alice-home', 'home.example');
const bobOnHome = user('bob-stub-on-home', 'bob-remote', 'remote.example');
const bobOnRemote = user('bob-remote');
const carolHome = user('carol-home');
const carolOnRemote = user('carol-stub-on-remote', 'carol-home', 'home.example');

const bobDmHome = wireDm({ id: 'dm-bob-home', federatedId: FID_ALICE_BOB, createdAt: 1, members: [aliceHome, bobOnHome] });
const bobDmRemote = wireDm({ id: 'dm-bob-remote', federatedId: FID_ALICE_BOB, createdAt: 2, members: [aliceOnRemote, bobOnRemote] });
const carolDmHome = wireDm({ id: 'dm-carol', createdAt: 1, members: [aliceHome, carolHome] });

// A group owned by alice, hosted on REMOTE, with every metadata field set.
const groupOnRemote = wireDm({
  id: 'dm-group-remote',
  federatedId: FID_GROUP,
  ownerId: 'alice-on-remote',
  ownerHomeUserId: 'alice-home',
  ownerHomeInstance: 'home.example',
  name: 'Weekend plans',
  icon: 'https://remote.example/uploads/group.png',
  metadataUpdatedAt: 42,
  createdAt: 3,
  members: [aliceOnRemote, bobOnRemote, carolOnRemote],
});

let remoteList: DmChannel[];

function fakeRemoteClient(): BackspaceApiClient {
  return { dm: { list: async (): Promise<DmChannel[]> => remoteList.map(copyDm) } } as unknown as BackspaceApiClient;
}

function rowIds(): string[] {
  return useSpaceStore.getState().dmChannels.map(d => d.id).sort();
}

beforeEach(() => {
  useSpaceStore.getState().reset();
  remoteList = [];
  setApiForOriginResolver(() => fakeRemoteClient());
  useChatStore.setState({ messages: new Map(), unreadChannels: new Set(), currentChannelId: null });
});

describe('reloadDmsForOrigin: a 1.6.1 peer lists DMs without the conversation key', () => {
  it('its copy of a conversation already shown from home is recorded as an alternate, not added as a second row', async () => {
    useSpaceStore.getState().populateFromReady('', [], [], [carolDmHome, bobDmHome]);
    remoteList = [asListedBy161(bobDmRemote)];

    await useSpaceStore.getState().reloadDmsForOrigin(REMOTE);

    expect(rowIds()).toEqual(['dm-bob-home', 'dm-carol']);
    expect(useSpaceStore.getState().dmAlternatives.get(FID_ALICE_BOB)?.get(REMOTE)).toBe('dm-bob-remote');
  });

  it('when it is listed before the home copy is known, the home copy arriving later still makes one row', async () => {
    remoteList = [asListedBy161(bobDmRemote)];
    await useSpaceStore.getState().reloadDmsForOrigin(REMOTE);
    expect(rowIds()).toEqual(['dm-bob-remote']);

    useSpaceStore.getState().populateFromReady('', [], [], [bobDmHome]);

    expect(rowIds()).toEqual(['dm-bob-home']);
    expect(useSpaceStore.getState().channelOriginMap.get('dm-bob-home')).toBe('');
  });

  it('a derived key never merges two rows the peer lists for the same pair: the keyed relay copy stays listed', async () => {
    // A legacy 1-on-1 the peer holds without a key (created while its relay
    // was off), and the relay-created copy with the key, for the same pair.
    const legacy = wireDm({ id: 'dm-bob-legacy', createdAt: 0, members: [aliceOnRemote, bobOnRemote] });
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], [legacy, bobDmRemote]);
    remoteList = [asListedBy161(legacy), asListedBy161(bobDmRemote)];

    await useSpaceStore.getState().reloadDmsForOrigin(REMOTE);

    expect(rowIds()).toEqual(['dm-bob-legacy', 'dm-bob-remote']);
    expect(useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-bob-remote')?.federatedId).toBe(FID_ALICE_BOB);
    expect(useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-bob-legacy')?.federatedId).toBeNull();
  });

  it('a mirror id the client has never seen, alone in the list for its pair, still derives the key and dedups against home', async () => {
    useSpaceStore.getState().populateFromReady('', [], [], [carolDmHome, bobDmHome]);
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], []);
    remoteList = [asListedBy161(bobDmRemote)];

    await useSpaceStore.getState().reloadDmsForOrigin(REMOTE);

    expect(rowIds()).toEqual(['dm-bob-home', 'dm-carol']);
    expect(useSpaceStore.getState().dmAlternatives.get(FID_ALICE_BOB)?.get(REMOTE)).toBe('dm-bob-remote');
  });

  it('a copy the peer stated unkeyed in ready stays its own row through a keyless reload (#345)', async () => {
    // Created on REMOTE while its relay was off: REMOTE's ready states null.
    const unkeyed = wireDm({ id: 'dm-bob-unkeyed', federatedId: null, createdAt: 5, members: [aliceOnRemote, bobOnRemote] });
    useSpaceStore.getState().populateFromReady('', [], [], [bobDmHome]);
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], [unkeyed]);
    remoteList = [asListedBy161(unkeyed)];

    await useSpaceStore.getState().reloadDmsForOrigin(REMOTE);

    expect(rowIds()).toEqual(['dm-bob-home', 'dm-bob-unkeyed']);
    expect(useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-bob-unkeyed')?.federatedId).toBeNull();
  });

  it('a key it already knows for a listed channel is kept, not replaced by the missing field', async () => {
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], [groupOnRemote]);
    remoteList = [asListedBy161(groupOnRemote)];

    await useSpaceStore.getState().reloadDmsForOrigin(REMOTE);

    expect(useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-group-remote')?.federatedId).toBe(FID_GROUP);
  });

  it('a group keeps its name, icon and owner identity when the list leaves them out', async () => {
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], [groupOnRemote]);
    remoteList = [asListedBy161(groupOnRemote)];

    await useSpaceStore.getState().reloadDmsForOrigin(REMOTE);

    expect(useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-group-remote')).toMatchObject({
      federatedId: FID_GROUP,
      ownerId: 'alice-on-remote',
      ownerHomeUserId: 'alice-home',
      ownerHomeInstance: 'home.example',
      name: 'Weekend plans',
      icon: 'https://remote.example/uploads/group.png',
      metadataUpdatedAt: 42,
    });
  });
});

describe('reloadDmsForOrigin: a current server lists DMs in the ready shape', () => {
  it('a home reload keeps every row keyed, so later mirrored copies still resolve', async () => {
    useSpaceStore.getState().populateFromReady('', [], [], [carolDmHome, bobDmHome]);
    const listSpy = vi.spyOn(api.dm, 'list').mockResolvedValue([carolDmHome, bobDmHome].map(copyDm));
    try {
      await useSpaceStore.getState().reloadDmsForOrigin('');
    } finally {
      listSpy.mockRestore();
    }
    expect(rowIds()).toEqual(['dm-bob-home', 'dm-carol']);
    expect(useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-bob-home')?.federatedId).toBe(FID_ALICE_BOB);
  });

  it('a value the list sends as null replaces what the client held (a removed group icon stays removed)', async () => {
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], [groupOnRemote]);
    remoteList = [{ ...groupOnRemote, icon: null, metadataUpdatedAt: 43 }];

    await useSpaceStore.getState().reloadDmsForOrigin(REMOTE);

    const group = useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-group-remote');
    expect(group?.icon).toBeNull();
    expect(group?.metadataUpdatedAt).toBe(43);
  });

  it('a 1-on-1 the server lists without a key (never federated) gets none made up for it', async () => {
    const listSpy = vi.spyOn(api.dm, 'list').mockResolvedValue([copyDm(carolDmHome)]);
    try {
      await useSpaceStore.getState().reloadDmsForOrigin('');
    } finally {
      listSpy.mockRestore();
    }
    expect(useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-carol')?.federatedId).toBeNull();
  });
});
