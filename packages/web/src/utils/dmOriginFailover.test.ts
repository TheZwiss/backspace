import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock useWebSocket imports that instanceStore / chatStore transitively depend on.
vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
  wsSendAll: vi.fn(),
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
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

// The signed-in account is homed on B, so B's copy of a conversation is the
// pinned one while B is connected (the pin rule's home is the layout home).
vi.mock('../stores/authStore', () => {
  const state = { user: { id: 'u-home', username: 'u', homeInstance: 'b.example', homeUserId: 'u-on-b' }, token: 't' };
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
import { setOriginFromHostnameResolver } from './crossStoreResolvers';
import { applyIncomingDmMessage } from './dmMessageRouting';
import type { DmChannel, DmMessageWithUser } from '@backspace/shared';

const B = 'https://b.example';
const C = 'https://c.example';

function makeDm(id: string, federatedId: string | null): DmChannel {
  return { id, federatedId, createdAt: 1000, members: [] };
}

function listFrom(origin: string, dms: DmChannel[]): void {
  useSpaceStore.getState().populateFromReady(origin, [], [], dms);
}

function rowIds(): string[] {
  return useSpaceStore.getState().dmChannels.map(d => d.id).sort();
}

beforeEach(() => {
  setOriginFromHostnameResolver((host) => (host === 'b.example' ? B : host === 'c.example' ? C : ''));
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
  // Replace history.replaceState to observe URL writes in tests.
  vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
});

describe('DM failover: setDmOriginAvailable(origin, false) and the pin-move effect', () => {
  it('no-ops when the dropped origin pins no DM', () => {
    listFrom('', [makeDm('home-1', 'fed-aaa')]);

    useSpaceStore.getState().setDmOriginAvailable(C, false);

    expect(useSpaceStore.getState().channelOriginMap.get('home-1')).toBe('');
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it('moves a DM to the connected home copy, and its chat state with it', () => {
    listFrom(B, [makeDm('b-1', 'fed-aaa')]);
    listFrom('', [makeDm('home-1', 'fed-aaa')]);
    expect(rowIds()).toEqual(['b-1']);
    useChatStore.setState({
      messages: new Map([['b-1', []]]),
      readStates: new Map([['b-1', 'prev']]),
      unreadChannels: new Set(['b-1']),
      currentChannelId: 'b-1',
    });

    useSpaceStore.getState().setDmOriginAvailable(B, false);

    const sp = useSpaceStore.getState();
    expect(rowIds()).toEqual(['home-1']);
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

  it('moves to the first reachable copy the client learned, here the browsed instance\'s', () => {
    listFrom(B, [makeDm('b-1', 'fed-aaa')]);
    listFrom('', [makeDm('home-1', 'fed-aaa')]);
    listFrom(C, [makeDm('c-1', 'fed-aaa')]);

    useSpaceStore.getState().setDmOriginAvailable(B, false);

    expect(rowIds()).toEqual(['home-1']);
  });

  it('falls back to a connected sibling when the browsed instance holds no copy', () => {
    listFrom(B, [makeDm('b-1', 'fed-aaa')]);
    listFrom(C, [makeDm('c-1', 'fed-aaa')]);

    useSpaceStore.getState().setDmOriginAvailable(B, false);

    expect(rowIds()).toEqual(['c-1']);
    expect(useSpaceStore.getState().channelOriginMap.get('c-1')).toBe(C);
  });

  it('leaves the pin untouched when no other copy is connected', () => {
    listFrom(B, [makeDm('b-1', 'fed-aaa')]);
    listFrom(C, [makeDm('c-1', 'fed-aaa')]);
    useSpaceStore.getState().setDmOriginAvailable(C, false);

    useSpaceStore.getState().setDmOriginAvailable(B, false);

    expect(rowIds()).toEqual(['b-1']);
    expect(useSpaceStore.getState().channelOriginMap.get('b-1')).toBe(B);
  });

  it('leaves a DM without a key where it is', () => {
    listFrom(B, [makeDm('b-local', null)]);

    useSpaceStore.getState().setDmOriginAvailable(B, false);

    expect(useSpaceStore.getState().channelOriginMap.get('b-local')).toBe(B);
  });

  it('keeps the dropped origin\'s copy, and its returning ready moves the DM back to the home copy', () => {
    listFrom(B, [makeDm('b-1', 'fed-aaa')]);
    listFrom('', [makeDm('home-1', 'fed-aaa')]);
    useSpaceStore.getState().setDmOriginAvailable(B, false);
    expect(useSpaceStore.getState().dmAlternatives.get('fed-aaa')?.get(B)).toBe('b-1');

    listFrom(B, [makeDm('b-1', 'fed-aaa')]);

    expect(rowIds()).toEqual(['b-1']);
    expect(useSpaceStore.getState().channelOriginMap.get('b-1')).toBe(B);
  });

  it('a returning sibling that is not home does not take the DM back', () => {
    listFrom(C, [makeDm('c-1', 'fed-aaa')]);
    listFrom('', [makeDm('home-1', 'fed-aaa')]);
    // The account's home B holds no copy, so C's copy, listed first, is pinned.
    expect(rowIds()).toEqual(['c-1']);
    useSpaceStore.getState().setDmOriginAvailable(C, false);
    expect(rowIds()).toEqual(['home-1']);

    listFrom(C, [makeDm('c-1', 'fed-aaa')]);

    expect(rowIds()).toEqual(['home-1']);
  });

  it('a DM that fails over shows the newest message its new copy received, not the one it was listed with', async () => {
    const at = (id: string, dmChannelId: string, content: string, createdAt: number): DmMessageWithUser => ({
      id, dmChannelId, userId: 'bob', user: { id: 'bob', username: 'bob' } as DmMessageWithUser['user'],
      content, createdAt, attachments: [], embeds: [], reactions: [],
    });
    listFrom(B, [{ ...makeDm('b-1', 'fed-aaa'), lastMessage: at('m1-b', 'b-1', 'first', 2000) }]);
    listFrom('', [{ ...makeDm('home-1', 'fed-aaa'), lastMessage: at('m1-home', 'home-1', 'first', 2000) }]);
    listFrom(C, [{ ...makeDm('c-1', 'fed-bbb'), lastMessage: at('m-c', 'c-1', 'other', 3000) }]);
    expect(rowIds()).toEqual(['b-1', 'c-1']);

    // The same new message reaches both copies; only B's is shown.
    await applyIncomingDmMessage(B, at('m2-b', 'b-1', 'newest', 4000));
    await applyIncomingDmMessage('', at('m2-home', 'home-1', 'newest', 4000));
    // The copy not shown takes no part in the message list or unread state (#295).
    expect(useChatStore.getState().messages.has('home-1')).toBe(false);
    expect(useChatStore.getState().unreadChannels.has('home-1')).toBe(false);

    useSpaceStore.getState().setDmOriginAvailable(B, false);

    const sp = useSpaceStore.getState();
    expect(sp.dmChannels.map(d => d.id)).toEqual(['home-1', 'c-1']);
    expect(sp.dmChannels[0]?.lastMessage?.content).toBe('newest');
    expect(sp.channelLastMessageIds.get('home-1')).toBe('m2-home');
  });

  it('updates the URL via history.replaceState when moving the DM on screen', () => {
    window.history.pushState({}, '', '/channels/@me/b-1');
    listFrom(B, [makeDm('b-1', 'fed-aaa')]);
    listFrom('', [makeDm('home-1', 'fed-aaa')]);
    useChatStore.setState({ currentChannelId: 'b-1' });

    useSpaceStore.getState().setDmOriginAvailable(B, false);

    expect(window.history.replaceState).toHaveBeenCalledWith(
      expect.anything(),
      '',
      expect.stringContaining('/channels/@me/home-1'),
    );
  });

  it('does not touch voice state during failover (voice is handled separately)', async () => {
    listFrom(B, [makeDm('b-1', 'fed-aaa')]);
    listFrom('', [makeDm('home-1', 'fed-aaa')]);

    const { useVoiceStore } = await import('../stores/voiceStore');
    const beforeActive = useVoiceStore.getState().activeDmCall;
    const beforeOutgoing = useVoiceStore.getState().outgoingCall;
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'b-1' } });

    useSpaceStore.getState().setDmOriginAvailable(B, false);

    expect(useVoiceStore.getState().activeDmCall?.dmChannelId).toBe('b-1');
    // Restore
    useVoiceStore.setState({ activeDmCall: beforeActive, outgoingCall: beforeOutgoing });
  });
});
