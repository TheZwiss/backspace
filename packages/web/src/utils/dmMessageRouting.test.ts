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
vi.mock('../stores/authStore', () => {
  const state = { user: { id: 'alice-home', username: 'alice', homeInstance: null, homeUserId: null }, token: 't' };
  return {
    useAuthStore: Object.assign(
      (selector: (s: unknown) => unknown) => selector(state),
      { getState: () => state, setState: vi.fn(), subscribe: vi.fn() },
    ),
  };
});

vi.mock('../stores/instanceStore', async () => {
  const { create } = await import('zustand');
  const store = create<{ instances: unknown[] }>()(() => ({ instances: [] }));
  return { useInstanceStore: store };
});

import { useSpaceStore, setApiForOriginResolver, setMyUserIdForOrigin } from '../stores/spaceStore';
import { useChatStore } from '../stores/chatStore';
import { api, type BackspaceApiClient } from '../api/client';
import { applyIncomingDmMessage, applyIncomingDmChannel } from './dmMessageRouting';
import { repinDmsToHomeCopies } from './dmOriginFailover';
import type { DmChannel, DmMessageWithUser, User } from '@backspace/shared';

const REMOTE = 'https://remote.example';

function user(id: string, homeUserId: string | null = null, homeInstance: string | null = null): User {
  return {
    id, username: id, displayName: null, avatar: null, avatarColor: null, status: 'online',
    createdAt: 1, homeInstance, homeUserId,
  } as User;
}

// Alice as seen on each instance: her native row at home, her federated account on REMOTE.
const aliceHome = user('alice-home');
const aliceOnRemote = user('alice-on-remote', 'alice-home', 'home.example');
// Bob is native on REMOTE; home holds a replicated row for him.
const bobOnHome = user('bob-stub-on-home', 'bob-remote', 'remote.example');
const bobOnRemote = user('bob-remote');
// Carol is a local user on the home instance.
const carolHome = user('carol-home');

function message(overrides: Partial<DmMessageWithUser> & Pick<DmMessageWithUser, 'id' | 'dmChannelId' | 'userId' | 'user'>): DmMessageWithUser {
  return {
    content: 'hello',
    createdAt: 5_000,
    attachments: [],
    embeds: [],
    reactions: [],
    ...overrides,
  };
}

const carolDm: DmChannel = {
  id: 'dm-carol', federatedId: null, createdAt: 1, members: [aliceHome, carolHome],
  lastMessage: { id: 'm-carol-1', dmChannelId: 'dm-carol', userId: 'carol-home', content: 'hi alice', createdAt: 4_000 },
};
const bobDm: DmChannel = {
  id: 'dm-bob-home', federatedId: 'fid-alice-bob', createdAt: 1, members: [aliceHome, bobOnHome],
  lastMessage: null,
};
// REMOTE's copy of the same conversation, as REMOTE's GET /api/dm returns it.
const bobDmOnRemote: DmChannel = {
  id: 'dm-bob-remote', federatedId: 'fid-alice-bob', createdAt: 2, members: [aliceOnRemote, bobOnRemote],
  lastMessage: null,
};

let remoteDmList: DmChannel[];
let remoteListCalls: number;

function fakeRemoteClient(): BackspaceApiClient {
  const dm = {
    list: async (): Promise<DmChannel[]> => {
      remoteListCalls += 1;
      return remoteDmList.map(d => ({ ...d, members: d.members.map(m => ({ ...m })) }));
    },
  };
  return { dm } as unknown as BackspaceApiClient;
}

beforeEach(() => {
  useSpaceStore.getState().reset();
  remoteDmList = [bobDmOnRemote];
  remoteListCalls = 0;
  setApiForOriginResolver(() => fakeRemoteClient());
  setMyUserIdForOrigin(REMOTE, 'alice-on-remote');

  // Carol's DM is unread (so it sorts first); alice is looking at bob's DM.
  useSpaceStore.setState({
    dmChannels: [carolDm, bobDm],
    channelOriginMap: new Map([['dm-carol', ''], ['dm-bob-home', '']]),
    // REMOTE's ready arrived before its copy of the bob DM existed, so only the
    // home copy is recorded.
    dmAlternatives: new Map([['fid-alice-bob', new Map([['', 'dm-bob-home']])]]),
  });
  useChatStore.setState({
    messages: new Map(),
    unreadChannels: new Set(['dm-carol']),
    currentChannelId: 'dm-bob-home',
  });
});

function contentsOf(channelId: string): (string | null)[] {
  return (useChatStore.getState().messages.get(channelId) ?? []).map(m => m.content);
}

function dmById(id: string): DmChannel | undefined {
  return useSpaceStore.getState().dmChannels.find(d => d.id === id);
}

describe('applyIncomingDmMessage: a message never lands in another conversation (#296)', () => {
  it('the mirrored copy of alice\'s message to bob does not enter carol\'s unread DM', async () => {
    // alice -> bob, sent through home; REMOTE mirrors it and pushes its copy to
    // alice's federated account on REMOTE under REMOTE's channel id.
    await applyIncomingDmMessage(REMOTE, message({
      id: 'm-remote-1',
      dmChannelId: 'dm-bob-remote',
      userId: 'alice-on-remote',
      user: aliceOnRemote,
      content: 'for bob only',
      sourceInstance: 'https://home.example',
      sourceMessageId: 'm-home-1',
    }));

    expect(contentsOf('dm-carol')).not.toContain('for bob only');
    expect(dmById('dm-carol')?.lastMessage?.content).toBe('hi alice');
    expect(useChatStore.getState().unreadChannels.has('dm-carol')).toBe(true);
  });

  it('learns the unknown channel\'s conversation from the delivering origin and records it as an alternate', async () => {
    await applyIncomingDmMessage(REMOTE, message({
      id: 'm-remote-2',
      dmChannelId: 'dm-bob-remote',
      userId: 'alice-on-remote',
      user: aliceOnRemote,
      content: 'second',
      sourceInstance: 'https://home.example',
      sourceMessageId: 'm-home-2',
    }));

    expect(remoteListCalls).toBe(1);
    expect(useSpaceStore.getState().dmAlternatives.get('fid-alice-bob')?.get(REMOTE)).toBe('dm-bob-remote');
    // No second sidebar entry for the same conversation.
    expect(useSpaceStore.getState().dmChannels.filter(d => d.federatedId === 'fid-alice-bob')).toHaveLength(1);
  });

  it('a genuinely new conversation from an origin gets its own entry, not a guessed existing one', async () => {
    const daveOnRemote = user('dave-remote');
    const newDm: DmChannel = {
      id: 'dm-dave-remote', federatedId: 'fid-alice-dave', createdAt: 3, members: [aliceOnRemote, daveOnRemote],
      lastMessage: null,
    };
    remoteDmList = [bobDmOnRemote, newDm];

    await applyIncomingDmMessage(REMOTE, message({
      id: 'm-dave-1',
      dmChannelId: 'dm-dave-remote',
      userId: 'alice-on-remote',
      user: aliceOnRemote,
      content: 'hi dave',
    }));

    expect(contentsOf('dm-carol')).not.toContain('hi dave');
    expect(contentsOf('dm-bob-home')).not.toContain('hi dave');
    expect(contentsOf('dm-dave-remote')).toContain('hi dave');
    expect(dmById('dm-dave-remote')?.members.map(m => m.id).sort()).toEqual(['alice-on-remote', 'dave-remote']);
    expect(useSpaceStore.getState().channelOriginMap.get('dm-dave-remote')).toBe(REMOTE);
  });

  it('when the origin cannot be asked, a self-authored message is still not put into another conversation', async () => {
    setApiForOriginResolver(() => ({
      dm: { list: async () => { throw new Error('offline'); } },
    }) as unknown as BackspaceApiClient);

    await applyIncomingDmMessage(REMOTE, message({
      id: 'm-remote-3',
      dmChannelId: 'dm-bob-remote',
      userId: 'alice-on-remote',
      user: aliceOnRemote,
      content: 'while offline',
    }));

    expect(contentsOf('dm-carol')).not.toContain('while offline');
    expect(contentsOf('dm-bob-home')).not.toContain('while offline');
    expect(dmById('dm-carol')?.lastMessage?.content).toBe('hi alice');
  });

  it('a home-origin message for an unknown channel is resolved against the home list too', async () => {
    const listSpy = vi.spyOn(api.dm, 'list').mockResolvedValue([carolDm, bobDm]);
    try {
      await applyIncomingDmMessage('', message({
        id: 'm-home-x',
        dmChannelId: 'dm-unlisted',
        userId: 'alice-home',
        user: aliceHome,
        content: 'orphan',
      }));
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(contentsOf('dm-carol')).not.toContain('orphan');
      expect(contentsOf('dm-bob-home')).not.toContain('orphan');
    } finally {
      listSpy.mockRestore();
    }
  });
});

describe('applyIncomingDmMessage: the list holds only ids the pinned origin knows (#295)', () => {
  beforeEach(() => {
    // Both copies of the bob conversation are known; home is the pinned one.
    useSpaceStore.setState({
      dmAlternatives: new Map([['fid-alice-bob', new Map([['', 'dm-bob-home'], [REMOTE, 'dm-bob-remote']])]]),
    });
  });

  // bob's message as REMOTE (its home) pushes it, and as home pushes its relayed copy.
  const bobOnRemoteCopy = (): DmMessageWithUser => message({
    id: 'm-bob-remote', dmChannelId: 'dm-bob-remote', userId: 'bob-remote', user: bobOnRemote,
    content: 'question from bob',
  });
  const bobOnHomeCopy = (): DmMessageWithUser => message({
    id: 'm-bob-home', dmChannelId: 'dm-bob-home', userId: 'bob-stub-on-home', user: bobOnHome,
    content: 'question from bob', sourceInstance: REMOTE, sourceMessageId: 'm-bob-remote',
  });

  it('when the other instance delivers first, the conversation still ends up holding the pinned origin\'s id', async () => {
    await applyIncomingDmMessage(REMOTE, bobOnRemoteCopy());
    await applyIncomingDmMessage('', bobOnHomeCopy());

    // Replies and reactions are sent to home with this id; REMOTE's id means nothing there.
    expect((useChatStore.getState().messages.get('dm-bob-home') ?? []).map(m => m.id)).toEqual(['m-bob-home']);
  });

  it('a mirrored copy leaves the conversation\'s list, preview and unread state to the pinned copy', async () => {
    useChatStore.setState({ currentChannelId: 'dm-carol' });
    await applyIncomingDmMessage(REMOTE, bobOnRemoteCopy());

    expect(useChatStore.getState().messages.get('dm-bob-home') ?? []).toEqual([]);
    expect(dmById('dm-bob-home')?.lastMessage).toBeNull();
    expect(useChatStore.getState().unreadChannels.has('dm-bob-home')).toBe(false);

    await applyIncomingDmMessage('', bobOnHomeCopy());
    expect(contentsOf('dm-bob-home')).toEqual(['question from bob']);
    expect(dmById('dm-bob-home')?.lastMessage?.id).toBe('m-bob-home');
    expect(useChatStore.getState().unreadChannels.has('dm-bob-home')).toBe(true);
  });
});

describe('applyIncomingDmChannel: alternates are recorded when the copy is skipped (#296)', () => {
  it('a dm_channel_created for a conversation already listed records the alternate instead of dropping it', async () => {
    applyIncomingDmChannel(REMOTE, bobDmOnRemote);

    expect(useSpaceStore.getState().dmChannels.filter(d => d.federatedId === 'fid-alice-bob')).toHaveLength(1);
    expect(useSpaceStore.getState().dmAlternatives.get('fid-alice-bob')?.get(REMOTE)).toBe('dm-bob-remote');

    // A message for that channel from REMOTE now resolves without asking REMOTE.
    await applyIncomingDmMessage(REMOTE, message({
      id: 'm-remote-4',
      dmChannelId: 'dm-bob-remote',
      userId: 'alice-on-remote',
      user: aliceOnRemote,
      content: 'after channel created',
    }));
    expect(remoteListCalls).toBe(0);
    expect(contentsOf('dm-carol')).not.toContain('after channel created');
  });

  it('a dm_channel_created for a new conversation adds it under its origin', () => {
    const fresh: DmChannel = {
      id: 'dm-new-remote', federatedId: 'fid-new', createdAt: 9, members: [aliceOnRemote, bobOnRemote], lastMessage: null,
    };
    applyIncomingDmChannel(REMOTE, fresh);
    expect(dmById('dm-new-remote')).toBeDefined();
    expect(useSpaceStore.getState().channelOriginMap.get('dm-new-remote')).toBe(REMOTE);
    expect(useSpaceStore.getState().dmAlternatives.get('fid-new')?.get(REMOTE)).toBe('dm-new-remote');
  });
});

describe('the home copy of a conversation is the pinned one (#295 review)', () => {
  // U = alice (home is this client's home instance). She creates a DM with
  // vera, also homed here, through her account on C. C holds a copy but hosts
  // no participant, so vera's replies are relayed only to home.
  const C = 'https://c.example';
  const aliceOnC = user('alice-on-c', 'alice-home', 'home.example');
  const veraOnC = user('vera-stub-on-c', 'vera-home', 'home.example');
  const veraHome = user('vera-home');
  const dmOnC: DmChannel = {
    id: 'dm-uv-c', federatedId: 'fid-alice-vera', createdAt: 10, members: [aliceOnC, veraOnC], lastMessage: null,
  };
  const dmOnHome: DmChannel = {
    id: 'dm-uv-home', federatedId: 'fid-alice-vera', createdAt: 11, members: [aliceHome, veraHome], lastMessage: null,
  };

  beforeEach(() => {
    useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map(), dmAlternatives: new Map() });
    useChatStore.setState({ messages: new Map(), unreadChannels: new Set(), currentChannelId: null });
  });

  it('vera\'s reply appears live although C\'s copy was announced first', async () => {
    // C's dm_channel_created reaches the client first.
    applyIncomingDmChannel(C, dmOnC);
    expect(useSpaceStore.getState().channelOriginMap.get('dm-uv-c')).toBe(C);

    // Home created its copy from C's relay; vera's reply arrives from home.
    const listSpy = vi.spyOn(api.dm, 'list').mockResolvedValue([dmOnHome]);
    try {
      await applyIncomingDmMessage('', message({
        id: 'm-vera-1', dmChannelId: 'dm-uv-home', userId: 'vera-home', user: veraHome, content: 'reply from vera',
      }));
    } finally {
      listSpy.mockRestore();
    }

    const entries = useSpaceStore.getState().dmChannels.filter(d => d.federatedId === 'fid-alice-vera');
    expect(entries.map(d => d.id)).toEqual(['dm-uv-home']);
    expect(useSpaceStore.getState().channelOriginMap.get('dm-uv-home')).toBe('');
    expect(contentsOf('dm-uv-home')).toEqual(['reply from vera']);
  });

  it('a home dm_channel_created after the sibling\'s re-pins the conversation to home', () => {
    applyIncomingDmChannel(C, dmOnC);
    applyIncomingDmChannel('', dmOnHome);

    expect(useSpaceStore.getState().dmChannels.map(d => d.id)).toEqual(['dm-uv-home']);
    expect(useSpaceStore.getState().channelOriginMap.get('dm-uv-home')).toBe('');
  });

  it('a home ready payload after the sibling\'s re-pins the conversation to home', () => {
    const { populateFromReady } = useSpaceStore.getState();
    populateFromReady(C, [], [], [dmOnC]);
    populateFromReady('', [], [], [dmOnHome]);
    repinDmsToHomeCopies();

    expect(useSpaceStore.getState().dmChannels.filter(d => d.federatedId === 'fid-alice-vera').map(d => d.id))
      .toEqual(['dm-uv-home']);
    expect(useSpaceStore.getState().channelOriginMap.get('dm-uv-home')).toBe('');
  });

  it('once pinned to home, C\'s copies of later messages stay out of the list', async () => {
    applyIncomingDmChannel('', dmOnHome);
    applyIncomingDmChannel(C, dmOnC);

    await applyIncomingDmMessage(C, message({
      id: 'm-c-1', dmChannelId: 'dm-uv-c', userId: 'alice-on-c', user: aliceOnC, content: 'mirrored',
    }));
    expect(useChatStore.getState().messages.get('dm-uv-home') ?? []).toEqual([]);
    expect(useSpaceStore.getState().dmChannels.map(d => d.id)).toEqual(['dm-uv-home']);
  });
});
