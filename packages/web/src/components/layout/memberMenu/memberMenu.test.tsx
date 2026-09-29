import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberWithUser, Role, User } from '@backspace/shared';
import { PermissionBits } from '../../../utils/permissions';

vi.mock('../../../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
import { MemberSidebar } from '../MemberSidebar';
import { ContextMenuRenderer } from '../../ui/ContextMenuRenderer';
import { UserProfilePopout } from '../../ui/UserProfilePopout';
import { useAuthStore } from '../../../stores/authStore';
import * as spaces from '../../../stores/spaceStore';
import { useUIStore } from '../../../stores/uiStore';
import { useSocialStore } from '../../../stores/socialStore';
import { useContextMenuStore } from '../../../stores/contextMenuStore';
import { api } from '../../../api/client';
import { handleEvent } from '../../../hooks/webSocketEvents';

const role: Role = { id: 'mod', spaceId: 'space', name: 'Moderator', color: '#ff0000', position: 1, createdAt: 1 };
const user = (id: string): User => ({
  id, username: id, displayName: id, avatar: null, banner: null, accentColor: null,
  avatarColor: null, bio: null, status: 'online', customStatus: null, createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: []
});
const member = (id: string): MemberWithUser => ({ user: user(id), userId: id, spaceId: 'space', joinedAt: 1, nickname: null, roles: id === 'viewer' ? [{ ...role, id: 'senior', name: 'Senior', position: 2 }] : [] });
const allPermissions = (PermissionBits.MANAGE_SPACE | PermissionBits.MANAGE_ROLES | PermissionBits.KICK_MEMBERS | PermissionBits.BAN_MEMBERS).toString();
const update = vi.fn();
const remove = vi.fn();
const ban = vi.fn();
const toast = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  update.mockReset(); remove.mockReset(); ban.mockReset(); toast.mockReset();
  vi.spyOn(spaces, 'getApiForOrigin').mockReturnValue({ ...api, spaces: { ...api.spaces, updateMember: update, removeMember: remove, ban } });
  useAuthStore.setState({ user: user('viewer') });
  spaces.useSpaceStore.setState({
    currentSpaceId: 'space', loadingSpaceId: null, members: [member('owner'), member('viewer'), member('target')],
    roles: [{ ...role, id: 'space', name: '@everyone' }, role], userViews: new Map(),
    spaces: [{ id: 'space', name: 'Space', ownerId: 'owner', ownerTitle: null, _instanceOrigin: '' } as spaces.TaggedSpace],
    spacePermissions: new Map([['space', allPermissions]])
  });
  useSocialStore.setState({ friends: [], requests: [] });
  useUIStore.setState({
    isMobile: false, memberListOpen: true, activeModal: null,
    userProfilePopout: { user: null, anchor: null, member: null, placement: 'left' }
  });
  vi.spyOn(useUIStore.getState(), 'addToast').mockImplementation(toast);
  useContextMenuStore.getState().close();
});
afterEach(cleanup);
const mount = () => render(<MemoryRouter><MemberSidebar /><ContextMenuRenderer /></MemoryRouter>);
const rightClick = (name = 'target') => fireEvent.contextMenu(screen.getByText(name), { clientX: 950, clientY: 100 });
const openRoles = () => {
  const trigger = screen.getByRole('button', { name: /Roles/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowRight' });
  return screen.getByRole('menuitemcheckbox', { name: 'Moderator' });
};

describe('member context menu', () => {
  it.each(['viewer', 'owner', 'target'])('left click always opens profile for viewer %s', actor => {
    useAuthStore.setState({ user: user(actor) });
    mount();
    fireEvent.click(screen.getByText('target'));
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(useUIStore.getState().userProfilePopout.member).toEqual({ spaceId: 'space', userId: 'target' });
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('hides moderation and role editing for an equal-ranked member', () => {
    const state = spaces.useSpaceStore.getState();
    spaces.useSpaceStore.setState({ members: state.members.map(m => m.userId === 'target' ? { ...m, roles: [{ ...role, position: 2 }] } : m) });
    mount(); rightClick();
    expect(screen.queryByRole('button', { name: /Roles/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kick' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ban' })).not.toBeInTheDocument();
  });

  it('opens only the menu on right click, hiding self and owner management actions', () => {
    mount(); rightClick();
    expect(screen.getByRole('button', { name: 'View profile' })).toBeInTheDocument();
    expect(useUIStore.getState().userProfilePopout.user).toBeNull();
    rightClick('viewer');
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Friend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kick' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Roles/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change space nickname…' })).toBeInTheDocument();
    rightClick('owner');
    expect(screen.queryByRole('button', { name: 'Change space nickname…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ban' })).not.toBeInTheDocument();
  });

  it('does not offer privileged actions to ordinary members or an empty role submenu', () => {
    spaces.useSpaceStore.setState({ spacePermissions: new Map(), roles: [] });
    mount(); rightClick();
    expect(screen.queryByRole('button', { name: 'Change space nickname…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Roles/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kick' })).not.toBeInTheDocument();
  });

  it('waits for role confirmation, disables writes while pending and keeps the menu open', async () => {
    let resolve!: (member: MemberWithUser) => void;
    update.mockReturnValue(new Promise<MemberWithUser>(done => { resolve = done; }));
    mount(); rightClick(); const checkbox = openRoles();
    expect(screen.queryByRole('menuitemcheckbox', { name: '@everyone' })).not.toBeInTheDocument();
    fireEvent.click(checkbox); fireEvent.click(checkbox);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('space', 'target', { roleIds: ['mod'] });
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(checkbox).toBeDisabled();
    await act(async () => resolve({ ...member('target'), roles: [role] }));
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    expect(checkbox).not.toBeDisabled();
    expect(useContextMenuStore.getState().menu).not.toBeNull();
  });

  it('surfaces a failed role write without changing the checkmark', async () => {
    update.mockRejectedValue(new Error('Assignment rejected'));
    mount(); rightClick(); const checkbox = openRoles(); fireEvent.click(checkbox);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(checkbox).not.toBeDisabled();
  });

  it('supports keyboard closing and closes on a space switch', () => {
    mount(); rightClick(); const checkbox = openRoles();
    expect(checkbox).toHaveFocus();
    fireEvent.keyDown(checkbox, { key: 'Escape' });
    expect(useContextMenuStore.getState().openSubmenuKey).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(useContextMenuStore.getState().menu).toBeNull();
    rightClick();
    act(() => spaces.useSpaceStore.setState({ currentSpaceId: null }));
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('opens the flyout to the left when the right edge has no room', () => {
    mount(); rightClick();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      const trigger = this.getAttribute('aria-haspopup') === 'menu';
      return {
        x: trigger ? 900 : 0, left: trigger ? 900 : 0, right: trigger ? 1000 : 160, y: 100, top: 100, bottom: 200,
        width: trigger ? 100 : 160, height: 100, toJSON: () => ({})
      };
    });
    openRoles();
    expect(screen.getByRole('menu', { name: 'Roles / permission groups' })).toHaveStyle({ left: '736px' });
  });

  it('saves a space nickname and offers an explicit reset', async () => {
    update.mockResolvedValue({ ...member('target'), nickname: 'Pilot' });
    mount(); rightClick(); fireEvent.click(screen.getByRole('button', { name: 'Change space nickname…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Space nickname' }), { target: { value: '  Pilot  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Pilot');
    expect(update).toHaveBeenLastCalledWith('space', 'target', { nickname: 'Pilot' });
    rightClick('Pilot'); fireEvent.click(screen.getByRole('button', { name: 'Change space nickname…' }));
    update.mockResolvedValue(member('target'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('space', 'target', { nickname: null }));
  });

  it('keeps nickname input and exposes save failures', async () => {
    update.mockRejectedValue(new Error('Nickname rejected'));
    mount(); rightClick(); fireEvent.click(screen.getByRole('button', { name: 'Change space nickname…' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pilot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Pilot');
    expect(spaces.useSpaceStore.getState().members.find(m => m.userId === 'target')?.nickname).toBeNull();
  });

  it.each(['Kick', 'Ban'])('requires confirmation before %s and removes only after success', async label => {
    remove.mockResolvedValue(undefined); ban.mockResolvedValue(undefined);
    mount(); rightClick(); fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByText(label + ' target')).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled(); expect(ban).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(label === 'Kick' ? remove : ban).toHaveBeenCalledWith('space', 'target'));
    await waitFor(() => expect(screen.queryByText('target')).not.toBeInTheDocument());
  });

  it('uses instance-local IDs for remote member mutations', async () => {
    const space = spaces.useSpaceStore.getState().spaces[0]!;
    spaces.useSpaceStore.setState({ spaces: [{ ...space, _instanceOrigin: 'https://remote.test' }] });
    spaces.setMyUserIdForOrigin('https://remote.test', 'viewer');
    update.mockResolvedValue({ ...member('target'), roles: [role] });
    mount(); rightClick(); fireEvent.click(openRoles());
    await waitFor(() => expect(update).toHaveBeenCalledWith('space', 'target', { roleIds: ['mod'] }));
    expect(spaces.getApiForOrigin).toHaveBeenCalledWith('https://remote.test');
  });

  it('applies socket nickname/roles only for the current space and origin without overwriting presence', () => {
    const updated = { ...member('target'), nickname: 'Pilot', roles: [role], user: { ...user('target'), status: 'offline' as const } };
    handleEvent('https://other.test', { type: 'member_updated', spaceId: 'space', member: updated });
    expect(spaces.useSpaceStore.getState().members[2]?.nickname).toBeNull();
    handleEvent('', { type: 'member_updated', spaceId: 'other', member: { ...updated, spaceId: 'other' } });
    expect(spaces.useSpaceStore.getState().members[2]?.nickname).toBeNull();
    handleEvent('', { type: 'member_updated', spaceId: 'space', member: updated });
    expect(spaces.useSpaceStore.getState().members[2]).toMatchObject({ nickname: 'Pilot', roles: [role], user: { status: 'online' } });
  });
  it.each(['Enter', ' '])('activates role checkboxes with %s', async key => {
    update.mockResolvedValue({ ...member('target'), roles: [role] });
    mount(); rightClick(); const checkbox = openRoles();
    fireEvent.keyDown(checkbox, { key });
    await waitFor(() => expect(checkbox).toHaveAttribute('aria-checked', 'true'));
    expect(update).toHaveBeenCalledOnce();
  });

  it('removes an assigned role after server confirmation', async () => {
    spaces.useSpaceStore.setState({ members: [member('viewer'), { ...member('target'), roles: [role] }] });
    update.mockResolvedValue(member('target'));
    mount(); rightClick(); const checkbox = openRoles();
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toHaveAttribute('aria-checked', 'false'));
    expect(update).toHaveBeenCalledWith('space', 'target', { roleIds: [] });
  });

  it('opens roles on hover and dismisses the menu on an outside click', async () => {
    mount(); rightClick();
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Roles/ }));
    await screen.findByRole('menuitemcheckbox', { name: 'Moderator' });
    const menu = screen.getByRole('menu', { name: '' });
    fireEvent.mouseDown(menu.previousElementSibling!);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('opens the same profile from the menu', () => {
    mount(); rightClick(); fireEvent.click(screen.getByRole('button', { name: 'View profile' }));
    expect(useUIStore.getState().userProfilePopout.member).toEqual({ spaceId: 'space', userId: 'target' });
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('shows the space nickname without replacing the original account identity', () => {
    vi.spyOn(api.users, 'getMutuals').mockResolvedValue({ mutualFriends: [], mutualSpaces: [] });
    spaces.useSpaceStore.setState({ members: [{ ...member('target'), nickname: 'Pilot' }] });
    render(<MemoryRouter><UserProfilePopout user={{ ...user('target'), displayName: 'Original name' }}
      member={{ spaceId: 'space', userId: 'target' }} onClose={vi.fn()}
      anchor={{ left: 200, top: 100, right: 250, bottom: 150, width: 50, height: 50 }} /></MemoryRouter>);
    expect(screen.getByText('Original name')).toBeInTheDocument();
    expect(screen.getByText('@target')).toBeInTheDocument();
    expect(screen.getByText(/Space nickname: Pilot/)).toBeInTheDocument();
  });

  it.each(['Kick', 'Ban'])('keeps the member visible when %s fails', async label => {
    (label === 'Kick' ? remove : ban).mockRejectedValue(new Error('Removal rejected'));
    mount(); rightClick(); fireEvent.click(screen.getByRole('button', { name: label }));
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(spaces.useSpaceStore.getState().members.some(m => m.userId === 'target')).toBe(true);
  });

});
