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
vi.mock('../stores/authStore', async () => {
  const state = { user: { id: 'alice-home', username: 'alice', homeInstance: null, homeUserId: null }, token: 't' };
  return (await import('../test/authStoreMock')).authStoreMock(() => state);
});

vi.mock('../stores/instanceStore', async () => {
  const { create } = await import('zustand');
  const store = create<{ instances: unknown[] }>()(() => ({ instances: [] }));
  return { useInstanceStore: store };
});

import { useSpaceStore, setApiForOriginResolver } from '../stores/spaceStore';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { api, type BackspaceApiClient } from '../api/client';
import { applyIncomingDmMessage, applyIncomingDmChannel } from './dmMessageRouting';
import { wireDm, asListedBy161, copyDm } from '../test/dmWireShape';
import type { DmChannel, DmMessageWithUser, User } from '@backspace/shared';

const REMOTE = 'https://remote.example';

// The keys servers give these conversations: oneOnOneKey over the two
// members' home user ids (packages/server/src/utils/dmConversation.ts).
const FID_ALICE_BOB = 'fc8aa3239ccea0cd4cbfb7701d770ac9';
const FID_ALICE_DAVE = '9e29da28574912cfc1942cd6528d5a46';
const FID_ALICE_VERA = '987ee3b88eaaa8cb60bf9fe0f9808530';

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

// Fixtures in the wire shape of a current server (see test/dmWireShape.ts).
const carolDm = wireDm({
  id: 'dm-carol', createdAt: 1, members: [aliceHome, carolHome],
  lastMessage: { id: 'm-carol-1', dmChannelId: 'dm-carol', userId: 'carol-home', content: 'hi alice', createdAt: 4_000 },
});
const bobDm = wireDm({ id: 'dm-bob-home', federatedId: FID_ALICE_BOB, createdAt: 1, members: [aliceHome, bobOnHome] });
// REMOTE's copy of the same conversation.
const bobDmOnRemote = wireDm({
  id: 'dm-bob-remote', federatedId: FID_ALICE_BOB, createdAt: 2, members: [aliceOnRemote, bobOnRemote],
});

let remoteDmList: DmChannel[];
let remoteListCalls: number;
/** How REMOTE's GET /api/dm puts an entry on the wire: current servers send it whole. */
let remoteListShape: (dm: DmChannel) => DmChannel;

function fakeRemoteClient(): BackspaceApiClient {
  const dm = {
    list: async (): Promise<DmChannel[]> => {
      remoteListCalls += 1;
      return remoteDmList.map(d => remoteListShape(copyDm(d)));
    },
  };
  return { dm } as unknown as BackspaceApiClient;
}

beforeEach(() => {
  useSpaceStore.getState().reset();
  remoteDmList = [bobDmOnRemote];
  remoteListCalls = 0;
  remoteListShape = dm => dm;
  setApiForOriginResolver(() => fakeRemoteClient());
  useAuthStore.getState().recordMyRow(REMOTE, 'alice-on-remote');

  // Home lists carol's and bob's DMs. REMOTE's ready arrived before its copy
  // of the bob DM existed, so only the home copy is known.
  useSpaceStore.getState().populateFromReady('', [], [], [carolDm, bobDm].map(copyDm));
  useSpaceStore.getState().populateFromReady(REMOTE, [], [], []);
  // Carol's DM is unread (so it sorts first); alice is looking at bob's DM.
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

/** Every sidebar row, by id: a duplicate row shows up here whatever key it carries. */
function rowIds(): string[] {
  return useSpaceStore.getState().dmChannels.map(d => d.id).sort();
}

// REMOTE may run a current server or 1.6.1, whose GET /api/dm left out the
// conversation key; the client lists DMs from peers on either.
describe.each([
  ['a current server', (dm: DmChannel): DmChannel => dm],
  ['a 1.6.1 server', asListedBy161],
])('applyIncomingDmMessage: a message never lands in another conversation (#296), REMOTE on %s', (_label, shape) => {
  beforeEach(() => {
    remoteListShape = shape;
  });

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
    expect(useSpaceStore.getState().dmAlternatives.get(FID_ALICE_BOB)?.get(REMOTE)).toBe('dm-bob-remote');
    // No second sidebar row for the same conversation.
    expect(rowIds()).toEqual(['dm-bob-home', 'dm-carol']);
    expect(contentsOf('dm-bob-remote')).toEqual([]);
  });

  it('after the first message of a new conversation, a later mirrored copy resolves without another list read', async () => {
    const mirrored = (id: string, content: string): DmMessageWithUser => message({
      id, dmChannelId: 'dm-bob-remote', userId: 'alice-on-remote', user: aliceOnRemote, content,
      sourceInstance: 'https://home.example', sourceMessageId: `${id}-home`,
    });
    await applyIncomingDmMessage(REMOTE, mirrored('m-remote-first', 'test'));
    await applyIncomingDmMessage(REMOTE, mirrored('m-remote-next', 'next'));

    expect(remoteListCalls).toBe(1);
    expect(rowIds()).toEqual(['dm-bob-home', 'dm-carol']);
  });

  it('a genuinely new conversation from an origin gets its own entry, not a guessed existing one', async () => {
    const daveOnRemote = user('dave-remote');
    const newDm = wireDm({
      id: 'dm-dave-remote', federatedId: FID_ALICE_DAVE, createdAt: 3, members: [aliceOnRemote, daveOnRemote],
    });
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
    expect(dmById('dm-dave-remote')?.federatedId).toBe(FID_ALICE_DAVE);
    expect(useSpaceStore.getState().channelOriginMap.get('dm-dave-remote')).toBe(REMOTE);
    expect(rowIds()).toEqual(['dm-bob-home', 'dm-carol', 'dm-dave-remote']);
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
    const listSpy = vi.spyOn(api.dm, 'list').mockResolvedValue([carolDm, bobDm].map(copyDm));
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
      // The home rows keep their key through the reload.
      expect(dmById('dm-bob-home')?.federatedId).toBe(FID_ALICE_BOB);
    } finally {
      listSpy.mockRestore();
    }
  });
});

describe('applyIncomingDmMessage: the list holds only ids the pinned origin knows (#295)', () => {
  beforeEach(() => {
    // Both copies of the bob conversation are known; home is the pinned one.
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], [copyDm(bobDmOnRemote)]);
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

    expect(rowIds()).toEqual(['dm-bob-home', 'dm-carol']);
    expect(useSpaceStore.getState().dmAlternatives.get(FID_ALICE_BOB)?.get(REMOTE)).toBe('dm-bob-remote');

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
    const fresh = wireDm({
      id: 'dm-new-remote', federatedId: 'fid-new', createdAt: 9, members: [aliceOnRemote, bobOnRemote],
    });
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
  const dmOnC = wireDm({ id: 'dm-uv-c', federatedId: FID_ALICE_VERA, createdAt: 10, members: [aliceOnC, veraOnC] });
  const dmOnHome = wireDm({ id: 'dm-uv-home', federatedId: FID_ALICE_VERA, createdAt: 11, members: [aliceHome, veraHome] });

  beforeEach(() => {
    useSpaceStore.getState().reset();
    useChatStore.setState({ messages: new Map(), unreadChannels: new Set(), currentChannelId: null });
  });

  it('vera\'s reply appears live although C\'s copy was announced first', async () => {
    // C's dm_channel_created reaches the client first.
    applyIncomingDmChannel(C, dmOnC);
    expect(useSpaceStore.getState().channelOriginMap.get('dm-uv-c')).toBe(C);

    // Home created its copy from C's relay; vera's reply arrives from home.
    const listSpy = vi.spyOn(api.dm, 'list').mockResolvedValue([copyDm(dmOnHome)]);
    try {
      await applyIncomingDmMessage('', message({
        id: 'm-vera-1', dmChannelId: 'dm-uv-home', userId: 'vera-home', user: veraHome, content: 'reply from vera',
      }));
    } finally {
      listSpy.mockRestore();
    }

    expect(useSpaceStore.getState().dmChannels.map(d => d.id)).toEqual(['dm-uv-home']);
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

    expect(useSpaceStore.getState().dmChannels.map(d => d.id)).toEqual(['dm-uv-home']);
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
