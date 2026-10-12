import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import type { DmChannel, MemberWithUser, User } from '@backspace/shared';
import type { ContextMenuItem } from '../../stores/contextMenuStore';
const mocks = vi.hoisted(() => ({ open: vi.fn(), send: vi.fn(), toast: vi.fn() }));
vi.mock('../../stores/contextMenuStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../stores/contextMenuStore')>(),
  useContextMenuStore: { getState: () => ({ open: mocks.open }) },
}));
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: mocks.toast }) } }));
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: mocks.send }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn() } }));
import { useChannelPokeStore } from '../../stores/channelPokeStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthorMenu } from './useAuthorMenu';

const HOST = 'https://host.test';

function makeUser(id: string, username: string, displayName: string | null): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

// Ids on the hosting instance: the ids its channels' messages carry.
const target = makeUser('target-host', 'target@home.example', 'Target');
const stranger = makeUser('stranger-host', 'stranger', 'Stranger');
const targetMember: MemberWithUser = { spaceId: 'space-1', userId: target.id, nickname: 'Tee', joinedAt: 1, user: target, roles: [] };
const dm = { id: 'dm-1', ownerId: null, createdAt: 1, members: [target], lastMessage: null } as unknown as DmChannel;

const space = { channelId: 'chat', authorId: target.id, origin: HOST, isDm: false, canSend: true, isAuthor: false };
const inDm = { ...space, channelId: dm.id, isDm: true };

function rightClick(options: typeof space) {
  const { result } = renderHook(() => useAuthorMenu(options));
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 5, clientY: 6 };
  result.current(event as unknown as MouseEvent);
  return event;
}

function openedItems(): ContextMenuItem[] {
  expect(mocks.open).toHaveBeenCalledTimes(1);
  return mocks.open.mock.calls[0]![1] as ContextMenuItem[];
}

function action(key: string) {
  const item = openedItems().find((i) => i.key === key);
  if (item?.type !== 'action') throw Error(`Expected action ${key}`);
  return item;
}

beforeEach(() => {
  vi.clearAllMocks();
  useChannelPokeStore.getState().reset();
  useComposerStore.setState({ states: new Map() });
  useSpaceStore.setState({
    dmChannels: [dm],
    members: [targetMember],
    channelToSpaceMap: new Map([['chat', 'space-1']]),
    channelOriginMap: new Map([['chat', HOST], [dm.id, HOST]]),
  });
});

afterEach(() => {
  useSpaceStore.setState({ dmChannels: [], members: [], channelToSpaceMap: new Map(), channelOriginMap: new Map() });
});

describe('the author menu', () => {
  it('offers Mention by the space nickname, and Poke after it where the host offers pokes', () => {
    useChannelPokeStore.getState().setHost(HOST, true);
    const event = rightClick(space);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(openedItems().map((i) => i.key)).toEqual(['mention-author', 'poke-author']);
    expect(action('mention-author').label).toBe('@Tee');
  });

  it('offers Mention alone in a DM, by account name', () => {
    useChannelPokeStore.getState().setHost(HOST, true);
    rightClick(inDm);
    expect(openedItems().map((i) => i.key)).toEqual(['mention-author']);
    expect(action('mention-author').label).toBe('@Target');
  });

  it("adds the author's id on the channel's origin to that channel's draft", () => {
    useComposerStore.getState().setDraft('chat', 'hi');
    rightClick(space);
    action('mention-author').onClick();
    expect(useComposerStore.getState().get('chat').draftText).toBe('hi <@target-host> ');
    expect(useComposerStore.getState().get(dm.id).draftText).toBe('');
  });

  it('leaves the right click to the message menu where the viewer cannot write', () => {
    useChannelPokeStore.getState().setHost(HOST, true);
    // No SEND_MESSAGES, a message still sending, or a DM whose partner is gone.
    for (const options of [{ ...space, canSend: false }, { ...inDm, canSend: false }]) {
      const event = rightClick(options);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("offers neither Mention nor Poke on the viewer's own message and leaves it to the message menu", () => {
    useChannelPokeStore.getState().setHost(HOST, true);
    for (const options of [{ ...inDm, isAuthor: true }, { ...space, isAuthor: true }]) {
      const event = rightClick(options);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('offers no Mention for an author who is not one of the channel people', () => {
    // A member who left: the composer and the sent message could not name them.
    const event = rightClick({ ...space, authorId: stranger.id });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('sends a poke to the instance hosting the space and says so when the socket is closed', () => {
    useChannelPokeStore.getState().setHost(HOST, true);
    rightClick(space);
    mocks.send.mockReturnValue(false);
    action('poke-author').onClick();
    expect(mocks.send).toHaveBeenCalledWith({ type: 'channel_poke', channelId: 'chat', targetUserId: target.id }, HOST);
    expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), 'warning');
  });
});
