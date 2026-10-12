import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MemberWithUser, MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useComposerStore } from '../../stores/composerStore';
import { useChannelPokeStore } from '../../stores/channelPokeStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';
import { PermissionBits } from '../../utils/permissions';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { Message } from './Message';
import { MessageInput } from './MessageInput';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn().mockReturnValue(true) }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

function makeUser(id: string, username: string, displayName: string | null): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

const HOST = 'https://host.test';
const me = makeUser('me', 'alice', 'Alice');
// The space and the DM are on HOST: the ids in them are HOST's ids.
const meOnHost = makeUser('me-host', 'alice@home.example', 'Alice');
const bob = makeUser('bob-host', 'bob', 'Bob');
const dm = { id: 'dm-1', ownerId: null, createdAt: 1, members: [meOnHost, bob], lastMessage: null } as unknown as DmChannel;
const bobMember: MemberWithUser = { spaceId: 'space-1', userId: bob.id, nickname: 'Bobby', joinedAt: 1, user: bob, roles: [] };

function makeMessage(channelId: string, isDm: boolean, author: User = bob): MessageWithUser {
  return {
    id: 'msg-1',
    channelId: isDm ? '' : channelId,
    dmChannelId: isDm ? channelId : '',
    userId: author.id,
    content: 'hello',
    createdAt: 1000,
    user: author,
    attachments: [],
    embeds: [],
    reactions: [],
  } as unknown as MessageWithUser;
}

function renderChannel(channelId: string, message: MessageWithUser) {
  return render(
    <>
      <Message message={message} isCompact={false} isFirstInGroup={true} previousMessageId={null} />
      <MessageInput channelId={channelId} channelName="general" />
      <ContextMenuRenderer />
    </>,
  );
}

function rightClickAvatar(container: HTMLElement, userId: string) {
  const avatar = container.querySelector(`[data-poke-user="${userId}"]`);
  expect(avatar).not.toBeNull();
  fireEvent.contextMenu(avatar!, { clientX: 20, clientY: 30 });
}

function menuLabels(): string[] {
  return screen.queryAllByRole('menu').flatMap((menu) => Array.from(menu.querySelectorAll('button'), (b) => b.textContent ?? ''));
}

async function nextFrame() {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  useAuthStore.setState({ user: me });
  useAuthStore.getState().recordMyRow(HOST, meOnHost.id);
  useUIStore.setState({ isMobile: false });
  useSpaceStore.setState({
    currentSpaceId: 'space-1',
    dmChannels: [dm],
    members: [bobMember],
    channelToSpaceMap: new Map([['space-ch-1', 'space-1']]),
    channelOriginMap: new Map([['space-ch-1', HOST], [dm.id, HOST]]),
    channelPermissions: new Map([['space-ch-1', PermissionBits.SEND_MESSAGES]]),
  });
  useComposerStore.setState({ states: new Map() });
  useChannelPokeStore.getState().reset();
});

afterEach(() => {
  act(() => useContextMenuStore.getState().close());
  useSpaceStore.setState({
    currentSpaceId: null, dmChannels: [], members: [],
    channelToSpaceMap: new Map(), channelOriginMap: new Map(), channelPermissions: new Map(),
  });
  useAuthStore.setState({ user: null, myRowIds: new Map() });
});

describe('Message author context menu', () => {
  it('mentions a DM author: the token goes into the draft, the composer shows the name, focused with the caret at the end', async () => {
    useComposerStore.getState().setDraft(dm.id, 'hey');
    const { container } = renderChannel(dm.id, makeMessage(dm.id, true));

    rightClickAvatar(container, bob.id);
    expect(menuLabels()).toEqual(['@Bob']);
    fireEvent.click(screen.getByRole('menuitem', { name: '@Bob' }));
    await nextFrame();

    expect(useComposerStore.getState().get(dm.id).draftText).toBe('hey <@bob-host> ');
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textbox).toHaveValue('hey @Bob ');
    expect(textbox).toHaveFocus();
    expect(textbox.selectionStart).toBe('hey @Bob '.length);
    expect(textbox.selectionEnd).toBe('hey @Bob '.length);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('offers Mention by nickname and Poke in a space channel whose host offers pokes, from the name too', async () => {
    useChannelPokeStore.getState().setHost(HOST, true);
    renderChannel('space-ch-1', makeMessage('space-ch-1', false));

    fireEvent.contextMenu(screen.getAllByText('Bobby')[0]!, { clientX: 20, clientY: 30 });
    expect(menuLabels()).toEqual(['@Bobby', 'Poke']);
    fireEvent.click(screen.getByRole('menuitem', { name: '@Bobby' }));
    await nextFrame();

    expect(useComposerStore.getState().get('space-ch-1').draftText).toBe('<@bob-host> ');
    expect(screen.getByRole('textbox')).toHaveValue('@Bobby ');
  });

  it('opens the message menu instead where the viewer cannot send', () => {
    useSpaceStore.setState({ channelPermissions: new Map([['space-ch-1', 0n]]) });
    useChannelPokeStore.getState().setHost(HOST, true);
    const { container } = renderChannel('space-ch-1', makeMessage('space-ch-1', false));

    rightClickAvatar(container, bob.id);
    const labels = menuLabels();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).not.toContain('@Bobby');
    expect(labels).not.toContain('Poke');
  });

  it("opens the message menu on the viewer's own DM message", () => {
    const { container } = renderChannel(dm.id, makeMessage(dm.id, true, meOnHost));

    rightClickAvatar(container, meOnHost.id);
    const labels = menuLabels();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).not.toContain('@Alice');
  });

  it('opens the author menu from the keyboard on the focused name, under the name', () => {
    useChannelPokeStore.getState().setHost(HOST, true);
    renderChannel('space-ch-1', makeMessage('space-ch-1', false));
    const name = screen.getByRole('button', { name: 'Bobby' });
    name.getBoundingClientRect = () => ({ left: 100, right: 150, top: 40, bottom: 60, width: 50, height: 20, x: 100, y: 40, toJSON: () => ({}) });
    name.focus();
    expect(name).toHaveFocus();

    fireEvent.keyDown(name, { key: 'F10', shiftKey: true });
    expect(menuLabels()).toEqual(['@Bobby', 'Poke']);
    expect(useContextMenuStore.getState().menu?.position).toEqual({ x: 116, y: 60 });
    expect(screen.getByRole('menuitem', { name: '@Bobby' }).closest('[role="menu"]')).toHaveFocus();

    act(() => useContextMenuStore.getState().close());
    fireEvent.keyDown(name, { key: 'ContextMenu' });
    expect(menuLabels()).toEqual(['@Bobby', 'Poke']);

    act(() => useContextMenuStore.getState().close());
    fireEvent.keyDown(name, { key: 'F10' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the profile card with Enter or Space on the focused name', () => {
    renderChannel('space-ch-1', makeMessage('space-ch-1', false));
    const name = screen.getByRole('button', { name: 'Bobby' });
    for (const key of ['Enter', ' ']) {
      act(() => useUIStore.getState().closeUserProfile());
      fireEvent.keyDown(name, { key });
      expect(useUIStore.getState().userProfilePopout?.user.id).toBe(bob.id);
    }
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it("opens the message menu on the viewer's own space message, even where the host offers pokes", () => {
    useChannelPokeStore.getState().setHost(HOST, true);
    const { container } = renderChannel('space-ch-1', makeMessage('space-ch-1', false, meOnHost));

    rightClickAvatar(container, meOnHost.id);
    const labels = menuLabels();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).not.toContain('Poke');
    expect(labels).not.toContain('@Alice');
  });
});
