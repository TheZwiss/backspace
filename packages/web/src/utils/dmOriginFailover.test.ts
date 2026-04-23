import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock useWebSocket imports that instanceStore / chatStore transitively depend on.
vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
  wsSendAll: vi.fn(),
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
vi.mock('../utils/federationOps', () => ({
  clearPasswordSyncTimers: vi.fn(),
}));

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Stub authStore to avoid localStorage access during module init.
vi.mock('../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    {
      getState: () => ({ user: null, token: null }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

// Stub instanceStore to avoid TDZ crash from the module-level
// setApiForOriginResolver() call in instanceStore.ts.
// We use a factory so vitest hoisting sees a self-contained mock.
vi.mock('../stores/instanceStore', async () => {
  const { create } = await import('zustand');
  const store = create<{ instances: unknown[] }>()(() => ({ instances: [] }));
  return { useInstanceStore: store };
});

// Stub voiceStore to avoid Zustand persist localStorage issues in jsdom.
// The test only needs getState()/setState() to verify voice state is untouched.
vi.mock('../stores/voiceStore', async () => {
  const { create } = await import('zustand');
  const store = create<{
    activeDmCall: { dmChannelId: string } | null;
    outgoingCall: { dmChannelId: string } | null;
    incomingCall: unknown;
  }>()(() => ({
    activeDmCall: null,
    outgoingCall: null,
    incomingCall: null,
  }));
  return { useVoiceStore: store };
});

import { useSpaceStore } from '../stores/spaceStore';
import { useChatStore } from '../stores/chatStore';
import { useInstanceStore } from '../stores/instanceStore';
import { failoverDmOriginsFromDisconnected } from './dmOriginFailover';
import type { DmChannel, User } from '@backspace/shared';
import type { ConnectedInstance as Inst } from '../stores/instanceStore';

function makeDm(id: string, federatedId: string | null): DmChannel {
  return { id, federatedId, createdAt: 1000, members: [] };
}

function fakeUser(id: string): User {
  return {
    id, username: id, displayName: null, avatar: null, accentColor: null,
    banner: null, bio: null, status: 'online', activities: [], createdAt: 1,
    homeInstance: null, homeUserId: null,
  } as any;
}

function fakeInstance(origin: string, status: Inst['status']): Inst {
  return {
    origin,
    label: origin,
    token: 'tok',
    user: fakeUser(`u-${origin}`),
    username: 'u',
    status,
    api: {} as any,
  };
}

beforeEach(() => {
  useSpaceStore.getState().reset();
  useChatStore.setState({
    messages: new Map(),
    typingUsers: new Map(),
    hasMore: new Map(),
    readStates: new Map(),
    unreadChannels: new Set(),
    channelAccessTimes: new Map(),
    scrollPositions: new Map(),
    currentChannelId: null,
  });
  useInstanceStore.setState({ instances: [] });
  // Replace history.replaceState to observe URL writes in tests.
  vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
});

describe('failoverDmOriginsFromDisconnected', () => {
  it('no-ops when disconnected origin has no DMs pinned to it', () => {
    useSpaceStore.setState({
      dmChannels: [makeDm('home-1', 'fed-aaa')],
      channelOriginMap: new Map([['home-1', '']]),
      dmAlternatives: new Map([['fed-aaa', new Map([['', 'home-1']])]]),
    });
    useInstanceStore.setState({ instances: [fakeInstance('https://b.example', 'disconnected')] });

    failoverDmOriginsFromDisconnected('https://b.example');

    expect(useSpaceStore.getState().channelOriginMap.get('home-1')).toBe('');
  });

  it('re-keys a DM to the connected home alternative', () => {
    useSpaceStore.setState({
      dmChannels: [makeDm('b-1', 'fed-aaa')],
      channelOriginMap: new Map([['b-1', 'https://b.example']]),
      channelLastMessageIds: new Map([['b-1', 'msg-last-on-b']]),
      dmAlternatives: new Map([
        ['fed-aaa', new Map([
          ['https://b.example', 'b-1'],
          ['', 'home-1'],
        ])],
      ]),
    });
    useInstanceStore.setState({ instances: [fakeInstance('https://b.example', 'disconnected')] });
    useChatStore.setState({
      messages: new Map([['b-1', []]]),
      readStates: new Map([['b-1', 'prev']]),
      unreadChannels: new Set(['b-1']),
      currentChannelId: 'b-1',
    });

    failoverDmOriginsFromDisconnected('https://b.example');

    const sp = useSpaceStore.getState();
    expect(sp.dmChannels.find(d => d.id === 'home-1')).toBeTruthy();
    expect(sp.dmChannels.find(d => d.id === 'b-1')).toBeUndefined();
    expect(sp.channelOriginMap.get('home-1')).toBe('');
    expect(sp.channelOriginMap.has('b-1')).toBe(false);
    expect(sp.channelLastMessageIds.has('b-1')).toBe(false);

    const ch = useChatStore.getState();
    expect(ch.messages.has('b-1')).toBe(false);
    expect(ch.readStates.has('b-1')).toBe(false);
    expect(ch.unreadChannels.has('home-1')).toBe(true);
    expect(ch.unreadChannels.has('b-1')).toBe(false);
    expect(ch.currentChannelId).toBe('home-1');
  });

  it('prefers home (empty-string origin) when multiple alternatives are connected', () => {
    useSpaceStore.setState({
      dmChannels: [makeDm('b-1', 'fed-aaa')],
      channelOriginMap: new Map([['b-1', 'https://b.example']]),
      dmAlternatives: new Map([
        ['fed-aaa', new Map([
          ['https://b.example', 'b-1'],
          ['https://c.example', 'c-1'],
          ['', 'home-1'],
        ])],
      ]),
    });
    useInstanceStore.setState({
      instances: [
        fakeInstance('https://b.example', 'disconnected'),
        fakeInstance('https://c.example', 'connected'),
      ],
    });

    failoverDmOriginsFromDisconnected('https://b.example');

    expect(useSpaceStore.getState().channelOriginMap.get('home-1')).toBe('');
  });

  it('falls back to a connected remote when home is not an alternative', () => {
    useSpaceStore.setState({
      dmChannels: [makeDm('b-1', 'fed-aaa')],
      channelOriginMap: new Map([['b-1', 'https://b.example']]),
      dmAlternatives: new Map([
        ['fed-aaa', new Map([
          ['https://b.example', 'b-1'],
          ['https://c.example', 'c-1'],
        ])],
      ]),
    });
    useInstanceStore.setState({
      instances: [
        fakeInstance('https://b.example', 'disconnected'),
        fakeInstance('https://c.example', 'connected'),
      ],
    });

    failoverDmOriginsFromDisconnected('https://b.example');

    const sp = useSpaceStore.getState();
    expect(sp.channelOriginMap.get('c-1')).toBe('https://c.example');
    expect(sp.dmChannels.find(d => d.id === 'c-1')).toBeTruthy();
  });

  it('leaves the pin untouched when no alternatives are connected', () => {
    useSpaceStore.setState({
      dmChannels: [makeDm('b-1', 'fed-aaa')],
      channelOriginMap: new Map([['b-1', 'https://b.example']]),
      dmAlternatives: new Map([
        ['fed-aaa', new Map([
          ['https://b.example', 'b-1'],
          ['https://c.example', 'c-1'],
        ])],
      ]),
    });
    useInstanceStore.setState({
      instances: [
        fakeInstance('https://b.example', 'disconnected'),
        fakeInstance('https://c.example', 'error'),
      ],
    });

    failoverDmOriginsFromDisconnected('https://b.example');

    expect(useSpaceStore.getState().channelOriginMap.get('b-1')).toBe('https://b.example');
    expect(useSpaceStore.getState().dmChannels.find(d => d.id === 'b-1')).toBeTruthy();
  });

  it('skips DMs without a federatedId', () => {
    useSpaceStore.setState({
      dmChannels: [makeDm('b-local', null)],
      channelOriginMap: new Map([['b-local', 'https://b.example']]),
      dmAlternatives: new Map(),
    });
    useInstanceStore.setState({ instances: [fakeInstance('https://b.example', 'disconnected')] });

    failoverDmOriginsFromDisconnected('https://b.example');

    expect(useSpaceStore.getState().channelOriginMap.get('b-local')).toBe('https://b.example');
  });

  it('retains oldOrigin → oldLocalId in dmAlternatives after rekey for fail-back', () => {
    useSpaceStore.setState({
      dmChannels: [makeDm('b-1', 'fed-aaa')],
      channelOriginMap: new Map([['b-1', 'https://b.example']]),
      dmAlternatives: new Map([
        ['fed-aaa', new Map([
          ['https://b.example', 'b-1'],
          ['', 'home-1'],
        ])],
      ]),
    });
    useInstanceStore.setState({ instances: [fakeInstance('https://b.example', 'disconnected')] });

    failoverDmOriginsFromDisconnected('https://b.example');

    const alts = useSpaceStore.getState().dmAlternatives.get('fed-aaa');
    // Old primary (b) retained as alternative for possible future fail-back.
    expect(alts?.get('https://b.example')).toBe('b-1');
    // Alternative map entry for the new primary's own origin is removed — it IS the primary now.
    expect(alts?.has('')).toBe(false);
  });

  it('updates the URL via history.replaceState when rekeying the current channel', () => {
    window.history.pushState({}, '', '/channels/@me/b-1');
    useSpaceStore.setState({
      dmChannels: [makeDm('b-1', 'fed-aaa')],
      channelOriginMap: new Map([['b-1', 'https://b.example']]),
      dmAlternatives: new Map([
        ['fed-aaa', new Map([
          ['https://b.example', 'b-1'],
          ['', 'home-1'],
        ])],
      ]),
    });
    useInstanceStore.setState({ instances: [fakeInstance('https://b.example', 'disconnected')] });
    useChatStore.setState({ currentChannelId: 'b-1' });

    failoverDmOriginsFromDisconnected('https://b.example');

    expect(window.history.replaceState).toHaveBeenCalledWith(
      expect.anything(),
      '',
      expect.stringContaining('/channels/@me/home-1'),
    );
  });

  it('does not touch voice state during failover (voice is handled separately)', async () => {
    useSpaceStore.setState({
      dmChannels: [makeDm('b-1', 'fed-aaa')],
      channelOriginMap: new Map([['b-1', 'https://b.example']]),
      dmAlternatives: new Map([
        ['fed-aaa', new Map([['https://b.example', 'b-1'], ['', 'home-1']])],
      ]),
    });
    useInstanceStore.setState({ instances: [fakeInstance('https://b.example', 'disconnected')] });

    const { useVoiceStore } = await import('../stores/voiceStore');
    const beforeActive = useVoiceStore.getState().activeDmCall;
    const beforeOutgoing = useVoiceStore.getState().outgoingCall;
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'b-1' } });

    failoverDmOriginsFromDisconnected('https://b.example');

    expect(useVoiceStore.getState().activeDmCall?.dmChannelId).toBe('b-1');
    // Restore
    useVoiceStore.setState({ activeDmCall: beforeActive, outgoingCall: beforeOutgoing });
  });
});
