import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { MemberRolesModal } from './MemberRolesModal';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { api, HttpError, type BackspaceApiClient } from '../../api/client';
import { setApiForOriginResolver } from '../../utils/crossStoreResolvers';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString, stringToPermissions } from '../../utils/permissions';

// The member role editor, opened from the profile card's "Edit Roles". It
// follows the role hierarchy and the held-bits rule the server enforces
// (permissions.md), saves the membership as one full set and only the roles
// whose permissions changed, and keeps up with the member as the store moves.

const SPACE_ID = 'space-1';
const ORBIT = 'https://orbit.example';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

const EVERYONE_BITS = PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES;
// The viewer's Leads role: MANAGE_ROLES and KICK_MEMBERS, nothing else.
const LEAD_BITS = PermissionBits.MANAGE_ROLES | PermissionBits.KICK_MEMBERS;
const VIEWER_HELD = LEAD_BITS | EVERYONE_BITS;

function role(id: string, name: string, position: number, permissions: bigint): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: permissionsToString(permissions), createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', 0, EVERYONE_BITS);
const COUNCIL = role('r-council', 'Council', 4, PermissionBits.BAN_MEMBERS);
const LEADS = role('r-lead', 'Leads', 3, LEAD_BITS);
// Set up by the owner below the viewer: carries BAN_MEMBERS, which the viewer does not hold.
const BANNERS = role('r-banner', 'Banners', 2, PermissionBits.BAN_MEMBERS);
const HELPERS = role('r-helper', 'Helpers', 1, PermissionBits.KICK_MEMBERS);
const ROLES = [EVERYONE, COUNCIL, LEADS, BANNERS, HELPERS];

function user(id: string, extra: Partial<User> = {}): User {
  return {
    id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
    status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null,
    replicatedInstances: [], ...extra,
  };
}
function member(id: string, roles: Role[], extra: Partial<User> = {}): MemberWithUser {
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id, extra), roles };
}

const loadSpaceDetail = vi.fn(async () => undefined);

function seed(opts: { viewer?: string; held?: bigint; members?: MemberWithUser[]; space?: TaggedSpace } = {}): void {
  useAuthStore.setState({ user: user(opts.viewer ?? 'lead') });
  useSpaceStore.setState({
    spaces: [opts.space ?? SPACE],
    currentSpaceId: SPACE_ID,
    roles: ROLES,
    members: opts.members ?? [
      member('owner', []),
      member('lead', [LEADS]),
      member('helper', [HELPERS]),
      member('holder', [BANNERS]),
      member('plain', []),
    ],
    spacePermissions: new Map([[SPACE_ID, permissionsToString(opts.held ?? VIEWER_HELD)]]),
    loadSpaceDetail,
  });
}

function open(userId: string): void {
  useUIStore.setState({ activeModal: 'memberRoles', modalData: { spaceId: SPACE_ID, userId } });
  render(<MemberRolesModal />);
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name });
const toggle = (name: string) => screen.getByRole('switch', { name });
const selectedHeading = () => screen.getByRole('heading', { level: 3 });
const saveButton = () => screen.queryByRole('button', { name: 'Save' });

/** Clicks the role's name in the left pane, which selects it for the permission pane. */
async function selectRole(name: string): Promise<void> {
  const nameId = checkbox(name).getAttribute('aria-labelledby');
  const label = nameId ? document.getElementById(nameId) : null;
  if (!label) throw new Error(`no name element for ${name}`);
  await userEvent.click(label);
}

beforeEach(() => {
  loadSpaceDetail.mockClear();
  useUIStore.setState({
    isMobile: false,
    userProfilePopout: { user: null, anchor: null, placement: 'right', member: null },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setApiForOriginResolver(() => api);
  useUIStore.setState({ activeModal: null, modalData: {} });
});

describe('MemberRolesModal: who and what it opens on', () => {
  it('names the member through userDisplayName', () => {
    seed({ members: [member('lead', [LEADS]), member('mira', [], { displayName: '', username: 'mira@orbit.example' })] });
    open('mira');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('mira');
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveTextContent('orbit.example');
  });

  it('is titled with the action, like the other member dialogs', () => {
    seed();
    open('helper');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Edit roles for helper$/);
  });

  it('opens with the member\'s highest role selected', () => {
    seed({ members: [member('lead', [LEADS]), member('both', [HELPERS, BANNERS])] });
    open('both');
    expect(selectedHeading()).toHaveTextContent('Banners');
  });

  it('opens on @everyone for a member without roles', () => {
    seed();
    open('plain');
    expect(selectedHeading()).toHaveTextContent('@everyone');
  });

  it('gives each checkbox the role name and each truncated name a title', () => {
    seed();
    open('helper');
    expect(checkbox('Helpers')).toBeChecked();
    const nameId = checkbox('Council').getAttribute('aria-labelledby');
    expect(document.getElementById(nameId!)).toHaveAttribute('title', 'Council');
  });

  it('hands "View Profile" the space member, so the card shows their roles', async () => {
    seed();
    open('helper');
    await userEvent.click(screen.getByRole('button', { name: 'View Profile' }));
    expect(useUIStore.getState().activeModal).toBeNull();
    const popout = useUIStore.getState().userProfilePopout;
    expect(popout.user?.id).toBe('helper');
    expect(popout.member).toEqual({ spaceId: SPACE_ID, userId: 'helper' });
  });
});

describe('MemberRolesModal: hierarchy and held bits', () => {
  it('locks roles at or above the viewer\'s top role, with the reason', () => {
    seed();
    open('helper');
    expect(checkbox('Council')).toBeDisabled();
    expect(checkbox('Leads')).toBeDisabled();
    expect(checkbox('Helpers')).toBeEnabled();
    expect(screen.getByText('Roles at or above your highest role are locked.')).toBeInTheDocument();
  });

  it('locks giving a role that carries bits the viewer lacks, with the reason', () => {
    seed();
    open('helper');
    expect(checkbox('Banners')).toBeDisabled();
    expect(screen.getByText('Roles with permissions you do not have cannot be given.')).toBeInTheDocument();
  });

  it('lets the viewer take such a role away, which the hierarchy alone governs', () => {
    seed();
    open('holder');
    expect(checkbox('Banners')).toBeEnabled();
    expect(checkbox('Banners')).toBeChecked();
  });

  it('shows a role at or above the viewer read-only, with the note', async () => {
    seed();
    open('helper');
    await selectRole('Council');
    expect(screen.getByText(/ranks at or above your highest role/)).toBeInTheDocument();
    expect(toggle('Kick Members')).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(toggle('Kick Members'));
    expect(toggle('Kick Members')).toHaveAttribute('aria-checked', 'false');
    expect(saveButton()).toBeNull();
  });

  it('locks the toggles of bits the viewer does not hold, and keeps the held ones switchable', async () => {
    seed();
    open('helper');
    await selectRole('Helpers');
    expect(screen.getByText(/only switch permissions you have yourself/)).toBeInTheDocument();
    expect(toggle('Ban Members')).toHaveAttribute('aria-disabled', 'true');
    expect(toggle('Administrator')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByRole('img', { name: 'You do not have this permission' }).length).toBeGreaterThan(0);
    await userEvent.click(toggle('Ban Members'));
    expect(toggle('Ban Members')).toHaveAttribute('aria-checked', 'false');

    expect(toggle('Send Messages')).toHaveAttribute('aria-disabled', 'false');
    await userEvent.click(toggle('Send Messages'));
    expect(toggle('Send Messages')).toHaveAttribute('aria-checked', 'true');
  });

  it('leaves everything open to the owner', async () => {
    seed({ viewer: 'owner', held: ALL_PERMISSIONS });
    open('lead');
    for (const name of ['Council', 'Leads', 'Banners', 'Helpers']) expect(checkbox(name)).toBeEnabled();
    expect(screen.queryByText(/locked/)).toBeNull();
    await selectRole('Council');
    expect(toggle('Ban Members')).toHaveAttribute('aria-disabled', 'false');
  });

  it('locks nothing by rank on a space from before the hierarchy, where every role sits at 0', () => {
    const flat = ROLES.map((r) => ({ ...r, position: 0 }));
    const at = (id: string) => flat.find((r) => r.id === id)!;
    seed({ members: [member('owner', []), member('lead', [at('r-lead')]), member('helper', [at('r-helper')])] });
    useSpaceStore.setState({ roles: flat });
    open('helper');
    // Leads is the viewer's own role: locked by rank on a ranked space.
    expect(checkbox('Leads')).toBeEnabled();
    expect(checkbox('Helpers')).toBeEnabled();
    expect(screen.queryByText('Roles at or above your highest role are locked.')).toBeNull();
    // The held-bits rule still applies: Council and Banners carry BAN_MEMBERS, which the viewer lacks.
    expect(checkbox('Council')).toHaveAttribute('title', 'Roles with permissions you do not have cannot be given.');
    expect(checkbox('Banners')).toBeDisabled();
  });

  it('leaves everything open to an instance admin without a role', async () => {
    seed({
      viewer: 'admin', held: ALL_PERMISSIONS,
      members: [member('owner', []), member('admin', [], { isAdmin: true }), member('lead', [LEADS])],
    });
    open('lead');
    for (const name of ['Council', 'Leads', 'Banners', 'Helpers']) expect(checkbox(name)).toBeEnabled();
    expect(screen.queryByText(/locked/)).toBeNull();
    await selectRole('Council');
    expect(toggle('Ban Members')).toHaveAttribute('aria-disabled', 'false');
  });

  it('ranks the viewer by their id on a remote space', () => {
    seed({
      space: { ...SPACE, _instanceOrigin: ORBIT },
      members: [member('owner', []), member('lead-local', [LEADS]), member('helper', [HELPERS])],
    });
    useAuthStore.getState().recordMyRow(ORBIT, 'lead-local');
    open('helper');
    expect(checkbox('Council')).toBeDisabled();
    expect(checkbox('Helpers')).toBeEnabled();
  });
});

describe('MemberRolesModal: saving', () => {
  it('shows the save controls only while something changed', async () => {
    seed();
    open('helper');
    expect(saveButton()).toBeNull();
    await userEvent.click(checkbox('Helpers'));
    expect(saveButton()).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(saveButton()).toBeNull();
    expect(checkbox('Helpers')).toBeChecked();
  });

  it('puts the save controls in the permissions pane, under the toggles they save', async () => {
    seed();
    open('helper');
    await userEvent.click(checkbox('Helpers'));
    const pane = selectedHeading().closest('[data-pane="permissions"]');
    expect(pane).not.toBeNull();
    expect(pane).toContainElement(saveButton());
  });

  it('discards to the member\'s current roles, so a save keeps a role another moderator gave meanwhile', async () => {
    seed();
    const updateMember = vi.spyOn(api.spaces, 'updateMember').mockResolvedValue(member('helper', [BANNERS]));
    open('helper');

    await userEvent.click(checkbox('Helpers'));
    // Meanwhile another moderator gives Helper the Banners role.
    act(() => {
      useSpaceStore.setState((s) => ({
        members: s.members.map((m) => (m.userId === 'helper' ? { ...m, roles: [HELPERS, BANNERS] } : m)),
      }));
    });
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(checkbox('Banners')).toBeChecked();
    expect(checkbox('Helpers')).toBeChecked();
    expect(saveButton()).toBeNull();

    await userEvent.click(checkbox('Helpers'));
    await userEvent.click(saveButton()!);
    expect(updateMember).toHaveBeenCalledWith(SPACE_ID, 'helper', { roleIds: ['r-banner'] });
  });

  it('sends the full role set and only the roles whose permissions changed', async () => {
    seed();
    const updateMember = vi.spyOn(api.spaces, 'updateMember').mockResolvedValue(member('holder', [BANNERS, HELPERS]));
    const update = vi.spyOn(api.roles, 'update').mockResolvedValue(HELPERS);
    open('holder');

    await userEvent.click(checkbox('Helpers'));
    await selectRole('Helpers');
    await userEvent.click(toggle('Send Messages'));
    // Switched and switched back: not a change.
    await selectRole('@everyone');
    await userEvent.click(toggle('Kick Members'));
    await userEvent.click(toggle('Kick Members'));
    await userEvent.click(saveButton()!);

    expect(updateMember).toHaveBeenCalledTimes(1);
    const [spaceId, userId, body] = updateMember.mock.calls[0]!;
    expect([spaceId, userId]).toEqual([SPACE_ID, 'holder']);
    expect([...body.roleIds!].sort()).toEqual(['r-banner', 'r-helper']);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toBe('r-helper');
    expect(stringToPermissions(update.mock.calls[0]![2].permissions!)).toBe(PermissionBits.KICK_MEMBERS | PermissionBits.SEND_MESSAGES);
    // What the server answered is shown at once; the space itself is not
    // reloaded (space_access_changed refreshes it, #374).
    expect(loadSpaceDetail).not.toHaveBeenCalled();
    const holder = useSpaceStore.getState().members.find((m) => m.userId === 'holder');
    expect(holder?.roles.map((r) => r.id).sort()).toEqual(['r-banner', 'r-helper']);
  });

  it('shows a partial failure, keeps what landed, and retries only what did not save', async () => {
    seed();
    const updateMember = vi.spyOn(api.spaces, 'updateMember').mockResolvedValue(member('helper', []));
    const update = vi.spyOn(api.roles, 'update')
      .mockResolvedValueOnce(EVERYONE)
      .mockRejectedValueOnce(new HttpError(403, 'Forbidden', undefined, 'role_hierarchy'))
      .mockResolvedValue(HELPERS);
    open('helper');

    await userEvent.click(checkbox('Helpers'));
    await selectRole('@everyone');
    await userEvent.click(toggle('Kick Members'));
    await selectRole('Helpers');
    await userEvent.click(toggle('Send Messages'));
    await userEvent.click(saveButton()!);

    expect(screen.getByText('You can only do that to members and roles ranked below your highest role.')).toBeInTheDocument();
    expect(loadSpaceDetail).not.toHaveBeenCalled();
    expect(saveButton()).not.toBeNull();

    update.mockClear();
    await userEvent.click(saveButton()!);
    expect(updateMember).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toBe('r-helper');
  });

  it('writes to the space\'s own instance', async () => {
    seed({
      space: { ...SPACE, _instanceOrigin: ORBIT },
      members: [member('owner', []), member('lead-local', [LEADS]), member('helper', [HELPERS])],
    });
    useAuthStore.getState().recordMyRow(ORBIT, 'lead-local');
    const remote = { spaces: { updateMember: vi.fn(async () => member('helper', [])) }, roles: { update: vi.fn() } };
    setApiForOriginResolver((origin) => (origin === ORBIT ? (remote as unknown as BackspaceApiClient) : api));
    const home = vi.spyOn(api.spaces, 'updateMember');
    open('helper');

    await userEvent.click(checkbox('Helpers'));
    await userEvent.click(saveButton()!);

    expect(remote.spaces.updateMember).toHaveBeenCalledWith(SPACE_ID, 'helper', { roleIds: [] });
    expect(home).not.toHaveBeenCalled();
  });
});

describe('MemberRolesModal: keeping up with the store', () => {
  it('follows the member\'s roles while there is no local edit', () => {
    seed();
    open('helper');
    act(() => {
      useSpaceStore.setState((s) => ({
        members: s.members.map((m) => (m.userId === 'helper' ? { ...m, roles: [HELPERS, BANNERS] } : m)),
      }));
    });
    expect(checkbox('Banners')).toBeChecked();
    expect(saveButton()).toBeNull();
  });

  it('keeps a local edit when the member\'s roles change underneath', async () => {
    seed();
    open('helper');
    await userEvent.click(checkbox('Helpers'));
    act(() => {
      useSpaceStore.setState((s) => ({
        members: s.members.map((m) => (m.userId === 'helper' ? { ...m, roles: [HELPERS, BANNERS] } : m)),
      }));
    });
    expect(checkbox('Helpers')).not.toBeChecked();
    expect(saveButton()).not.toBeNull();
  });

  it('closes when the member leaves', () => {
    seed();
    open('helper');
    act(() => {
      useSpaceStore.setState((s) => ({ members: s.members.filter((m) => m.userId !== 'helper') }));
    });
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('closes when another space becomes the current one', () => {
    seed();
    open('helper');
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'space-2' });
    });
    expect(useUIStore.getState().activeModal).toBeNull();
  });
});

