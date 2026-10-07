import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { RolesPanel } from './RolesPanel';
import { useSpaceStore, setMyUserIdForOrigin, type TaggedSpace } from '../../../stores/spaceStore';
import { useAuthStore } from '../../../stores/authStore';
import { useUIStore } from '../../../stores/uiStore';
import { api, HttpError, type BackspaceApiClient } from '../../../api/client';
import { setApiForOriginResolver } from '../../../utils/crossStoreResolvers';
import { PermissionBits, permissionsToString } from '../../../utils/permissions';

// Reordering roles in Space Settings > Roles (permissions.md, "Role
// hierarchy", "Setting the order"): what the list offers to whom, the
// optimistic move and its rollback, and the instance the move goes to.

const SPACE_ID = 'space-1';
const ORBIT = 'https://orbit.example';

function space(origin: string): TaggedSpace {
  return {
    id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
    inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: origin,
  };
}

const MANAGE = permissionsToString(PermissionBits.MANAGE_ROLES);

function role(id: string, name: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: MANAGE, createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', 0);
const ADMINS = role('r-admin', 'Admins', 4);
const MODS = role('r-mod', 'Moderators', 3);
const REGULARS = role('r-regular', 'Regulars', 2);
const GUESTS = role('r-guest', 'Guests', 1);
const ROLES = [ADMINS, MODS, REGULARS, GUESTS, EVERYONE];

function user(id: string): User {
  return {
    id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
    status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null,
    replicatedInstances: [],
  };
}
function member(id: string, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id), roles };
}

const loadSpaceDetail = vi.fn(async () => undefined);

function seed(viewerId: string, origin = ''): void {
  useAuthStore.setState({ user: user(viewerId) });
  useSpaceStore.setState({
    spaces: [space(origin)],
    currentSpaceId: SPACE_ID,
    roles: ROLES,
    members: [
      member('owner', []),
      member('moderator', [MODS]),
      member('moderator-local', [MODS]),
      member('regular', [REGULARS]),
    ],
    spacePermissions: new Map([[SPACE_ID, MANAGE]]),
    loadSpaceDetail,
  });
}

function rankedIds(): string[] {
  return useSpaceStore.getState().roles
    .filter((r) => r.id !== SPACE_ID)
    .sort((a, b) => b.position - a.position)
    .map((r) => r.id);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  loadSpaceDetail.mockClear();
  useUIStore.setState({ isMobile: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what the role list offers', () => {
  it('says that the order is the hierarchy', () => {
    seed('owner');
    render(<RolesPanel spaceId={SPACE_ID} />);
    expect(screen.getByText(/higher in the list rank above/i)).toBeInTheDocument();
  });

  it('gives the owner a move control on every role but @everyone', () => {
    seed('owner');
    render(<RolesPanel spaceId={SPACE_ID} />);
    for (const name of ['Admins', 'Moderators', 'Regulars', 'Guests']) {
      expect(screen.getByRole('button', { name: `Move ${name}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /Move @everyone/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move Admins up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Guests down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Guests up' })).toBeEnabled();
  });

  it('locks the roles at or above a moderator\'s own and keeps the rest below it', () => {
    seed('moderator');
    render(<RolesPanel spaceId={SPACE_ID} />);
    expect(screen.queryByRole('button', { name: 'Move Admins' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move Moderators' })).toBeNull();
    expect(screen.getAllByLabelText(/ranks at or above your highest role/i)).toHaveLength(2);
    // Regulars sits right below the moderator's own rank: down only.
    expect(screen.getByRole('button', { name: 'Move Regulars up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Regulars down' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move Guests up' })).toBeEnabled();
  });

  it('offers no move controls when the instance keeps every role at the same position', () => {
    seed('owner');
    useSpaceStore.setState({ roles: ROLES.map((r) => ({ ...r, position: 0 })) });
    render(<RolesPanel spaceId={SPACE_ID} />);
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
  });
});

/** The row of the role named `name` in the order list: the element a user grabs. */
function roleRow(name: string): HTMLElement {
  const label = screen.getAllByText(name).find((el) => el.closest('[data-role-row]'));
  const row = label?.closest<HTMLElement>('[data-role-row]');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** A drag of `from`'s row dropped on the lower half of `onto`'s row (jsdom rows have no height). */
function dragRow(from: HTMLElement, onto: HTMLElement): void {
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(onto, { dataTransfer, clientY: 1 });
  fireEvent.drop(onto, { dataTransfer, clientY: 1 });
  fireEvent.dragEnd(from, { dataTransfer });
}

describe('dragging a role (#373)', () => {
  it('moves a role dragged by its row, through the same move as the arrows', async () => {
    seed('owner');
    const update = vi.spyOn(api.roles, 'update').mockResolvedValue({ ...ADMINS, position: 1 });
    render(<RolesPanel spaceId={SPACE_ID} />);

    expect(roleRow('Admins')).toHaveAttribute('draggable', 'true');
    // Each event is its own act, so the drag state is there for the next one.
    dragRow(roleRow('Admins'), roleRow('Guests'));
    await act(async () => {});

    expect(rankedIds()).toEqual(['r-mod', 'r-regular', 'r-guest', 'r-admin']);
    expect(update).toHaveBeenCalledWith(SPACE_ID, 'r-admin', { position: 1, below: 'r-guest' });
  });

  it('leaves locked roles and @everyone undraggable', () => {
    seed('moderator');
    render(<RolesPanel spaceId={SPACE_ID} />);
    expect(roleRow('Admins')).not.toHaveAttribute('draggable', 'true');
    expect(roleRow('Moderators')).not.toHaveAttribute('draggable', 'true');
    expect(roleRow('@everyone')).not.toHaveAttribute('draggable', 'true');
    expect(roleRow('Regulars')).toHaveAttribute('draggable', 'true');
  });

  it('does not drag on a phone, where the buttons move the role', () => {
    seed('owner');
    useUIStore.setState({ isMobile: true });
    render(<RolesPanel spaceId={SPACE_ID} />);
    expect(roleRow('Admins')).not.toHaveAttribute('draggable', 'true');
  });
});

describe('moving a role', () => {
  it('shows the new order at once and sends the move to the space\'s instance', async () => {
    seed('owner');
    const pending = deferred<Role>();
    const update = vi.spyOn(api.roles, 'update').mockReturnValue(pending.promise);
    render(<RolesPanel spaceId={SPACE_ID} />);

    await userEvent.click(screen.getByRole('button', { name: 'Move Guests up' }));

    expect(rankedIds()).toEqual(['r-admin', 'r-mod', 'r-guest', 'r-regular']);
    expect(update).toHaveBeenCalledWith(SPACE_ID, 'r-guest', { position: 2, above: 'r-regular' });

    await act(async () => { pending.resolve({ ...GUESTS, position: 2 }); });
    // No reload of its own: space_access_changed refreshes every member (#374).
    expect(loadSpaceDetail).not.toHaveBeenCalled();
    expect(rankedIds()).toEqual(['r-admin', 'r-mod', 'r-guest', 'r-regular']);
  });

  it('puts the order back and shows the server\'s reason when the move is refused', async () => {
    seed('owner');
    vi.spyOn(api.roles, 'update').mockRejectedValue(
      new HttpError(403, 'refused', undefined, 'role_hierarchy'),
    );
    render(<RolesPanel spaceId={SPACE_ID} />);

    await userEvent.click(screen.getByRole('button', { name: 'Move Guests up' }));

    // The reason shows right under the role that moved back, where the user
    // is looking, not in a banner at the top of a long list.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You can only do that to members and roles ranked below your highest role.');
    expect(alert.previousElementSibling).toHaveTextContent('Guests');
    expect(rankedIds()).toEqual(['r-admin', 'r-mod', 'r-regular', 'r-guest']);
  });

  it('clears the reason when the next move starts', async () => {
    seed('owner');
    const update = vi.spyOn(api.roles, 'update').mockRejectedValueOnce(
      new HttpError(403, 'refused', undefined, 'role_hierarchy'),
    );
    render(<RolesPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move Guests up' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    update.mockResolvedValueOnce({ ...GUESTS, position: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Move Guests up' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('moves a role with the arrow keys on its handle and keeps focus on it', async () => {
    seed('owner');
    const update = vi.spyOn(api.roles, 'update').mockResolvedValue({ ...ADMINS, position: 3 });
    render(<RolesPanel spaceId={SPACE_ID} />);

    const handle = screen.getByRole('button', { name: 'Move Admins' });
    handle.focus();
    await userEvent.keyboard('{ArrowDown}');

    expect(update).toHaveBeenCalledWith(SPACE_ID, 'r-admin', { position: 3, below: 'r-mod' });
    expect(rankedIds()).toEqual(['r-mod', 'r-admin', 'r-regular', 'r-guest']);
    expect(screen.getByRole('button', { name: 'Move Admins' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Admins moved to position 2 of 4');
  });

  it('names the role shown next to it, so a move from an out-of-date list does what the list showed', async () => {
    seed('owner');
    const update = vi.spyOn(api.roles, 'update').mockResolvedValue({ ...ADMINS, position: 3 });
    render(<RolesPanel spaceId={SPACE_ID} />);

    await userEvent.click(screen.getByRole('button', { name: 'Move Admins down' }));
    expect(update).toHaveBeenLastCalledWith(SPACE_ID, 'r-admin', { position: 3, below: 'r-mod' });

    // A refresh built before that move lands and shows Admins on top again.
    act(() => { useSpaceStore.setState({ roles: ROLES }); });
    await userEvent.click(screen.getByRole('button', { name: 'Move Admins down' }));

    // Below Moderators, as the list showed: the server, which has Admins
    // there already, leaves it there instead of moving it a second rank down.
    expect(update).toHaveBeenLastCalledWith(SPACE_ID, 'r-admin', { position: 3, below: 'r-mod' });
  });

  it('does not send a move the viewer may not make', async () => {
    seed('moderator');
    const update = vi.spyOn(api.roles, 'update');
    render(<RolesPanel spaceId={SPACE_ID} />);

    screen.getByRole('button', { name: 'Move Regulars' }).focus();
    await userEvent.keyboard('{ArrowUp}');

    expect(update).not.toHaveBeenCalled();
    expect(rankedIds()).toEqual(['r-admin', 'r-mod', 'r-regular', 'r-guest']);
  });

  it('opens the role when its row is clicked, not when its move control is', async () => {
    seed('owner');
    render(<RolesPanel spaceId={SPACE_ID} />);
    const row = screen.getByRole('button', { name: 'Regulars' });
    await userEvent.click(within(row).getByText('Regulars'));
    expect(screen.getByDisplayValue('Regulars')).toBeInTheDocument();
  });
});

describe('a space on another instance', () => {
  it('ranks the viewer by their id there and sends the move to that instance', async () => {
    // Home id "moderator" is not a member of the orbit space; the replicated
    // user "moderator-local" is, and holds Moderators there.
    seed('moderator', ORBIT);
    useSpaceStore.setState({
      members: [member('owner', []), member('moderator-local', [MODS]), member('regular', [REGULARS])],
    });
    setMyUserIdForOrigin(ORBIT, 'moderator-local');
    const remoteUpdate = vi.fn(async () => ({ ...GUESTS, position: 2 }));
    const remote = { roles: { update: remoteUpdate } } as unknown as BackspaceApiClient;
    const homeUpdate = vi.spyOn(api.roles, 'update');
    setApiForOriginResolver((origin) => (origin === ORBIT ? remote : api));

    render(<RolesPanel spaceId={SPACE_ID} />);
    expect(screen.queryByRole('button', { name: 'Move Moderators' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Move Guests up' }));

    expect(remoteUpdate).toHaveBeenCalledWith(SPACE_ID, 'r-guest', { position: 2, above: 'r-regular' });
    expect(homeUpdate).not.toHaveBeenCalled();
  });
});

describe('on a phone', () => {
  it('offers the up and down buttons without a drag handle', () => {
    seed('owner');
    useUIStore.setState({ isMobile: true });
    render(<RolesPanel spaceId={SPACE_ID} />);
    expect(screen.queryByRole('button', { name: 'Move Guests' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move Guests up' })).toBeEnabled();
    // 40 px, the touch target size of the other mobile controls.
    expect(screen.getByRole('button', { name: 'Move Guests up' })).toHaveClass('w-10', 'h-10');
    expect(screen.getByRole('button', { name: 'Move Guests down' })).toHaveClass('w-10', 'h-10');
  });
});
