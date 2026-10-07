import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { RolesPanel } from './RolesPanel';
import { useSpaceStore, type TaggedSpace } from '../../../stores/spaceStore';
import { useAuthStore } from '../../../stores/authStore';
import { useUIStore } from '../../../stores/uiStore';
import { api, type BackspaceApiClient } from '../../../api/client';
import { setApiForOriginResolver } from '../../../utils/crossStoreResolvers';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../../../utils/permissions';

// Roles live on the space's own instance, so every role write from Space
// Settings > Roles goes there through getApiForOrigin (client-federation.md),
// never to the viewer's home instance.

const SPACE_ID = 'space-1';
const ORBIT = 'https://orbit.example';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: ORBIT,
};

function role(id: string, name: string, position: number, permissions: bigint): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: permissionsToString(permissions), createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', 0, PermissionBits.VIEW_CHANNEL);
const LEADS = role('r-lead', 'Leads', 2, PermissionBits.MANAGE_ROLES);
const HELPERS = role('r-helper', 'Helpers', 1, PermissionBits.VIEW_CHANNEL);

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

function remoteClient() {
  const roles = {
    // The created role shows up in the store the way loadSpaceDetail would put it there.
    create: vi.fn(async (_spaceId: string, data: { name: string }) => {
      const created = role(`r-${data.name}`, data.name, 1, 0n);
      useSpaceStore.setState((s) => ({ roles: [...s.roles, created] }));
      return created;
    }),
    update: vi.fn(async () => HELPERS),
    delete: vi.fn(async () => ({ success: true })),
  };
  return { client: { roles } as unknown as BackspaceApiClient, roles };
}

beforeEach(() => {
  useUIStore.setState({ isMobile: false });
  // Home id "lead"; on orbit the viewer is their replicated user "lead-local".
  useAuthStore.setState({ user: user('lead') });
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    roles: [EVERYONE, LEADS, HELPERS],
    members: [member('owner', []), member('lead-local', [LEADS]), member('helper', [HELPERS])],
    spacePermissions: new Map([[SPACE_ID, permissionsToString(ALL_PERMISSIONS)]]),
    loadSpaceDetail: vi.fn(async () => undefined),
  });
  useAuthStore.getState().recordMyRow(ORBIT, 'lead-local');
});

afterEach(() => {
  vi.restoreAllMocks();
  setApiForOriginResolver(() => api);
});

describe('RolesPanel on a space of another instance', () => {
  let roles: ReturnType<typeof remoteClient>['roles'];
  let homeSpies: MockInstance[];
  let actor: UserEvent;

  beforeEach(() => {
    const remote = remoteClient();
    roles = remote.roles;
    setApiForOriginResolver((origin) => (origin === ORBIT ? remote.client : api));
    homeSpies = [
      vi.spyOn(api.roles, 'create'),
      vi.spyOn(api.roles, 'update'),
      vi.spyOn(api.roles, 'delete'),
    ];
    // No real-timer wait between simulated keystrokes and clicks.
    actor = userEvent.setup({ delay: null });
    render(<RolesPanel spaceId={SPACE_ID} />);
  });

  function expectNothingSentHome() {
    for (const spy of homeSpies) expect(spy).not.toHaveBeenCalled();
  }

  it('creates a role on that instance, never at home', async () => {
    await actor.click(screen.getByRole('button', { name: 'Create Role' }));
    expect(roles.create).toHaveBeenCalledWith(SPACE_ID, { name: 'new role' });
    expect(screen.getByRole('button', { name: 'Back to roles' })).toBeInTheDocument();
    expectNothingSentHome();
  });

  it('saves a role on that instance, never at home', async () => {
    await actor.click(screen.getByRole('button', { name: 'Helpers' }));
    const name = screen.getByDisplayValue('Helpers');
    await actor.clear(name);
    await actor.type(name, 'Greeters');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(roles.update).toHaveBeenCalledWith(SPACE_ID, 'r-helper', { name: 'Greeters' });
    expectNothingSentHome();
  });

  it('copies a role on that instance, never at home', async () => {
    await actor.click(screen.getByRole('button', { name: 'Helpers' }));
    await actor.click(screen.getByRole('button', { name: 'Copy Role' }));
    expect(roles.create).toHaveBeenCalledWith(SPACE_ID, expect.objectContaining({ name: 'Copy of Helpers' }));
    expect(screen.getByDisplayValue('Copy of Helpers')).toBeInTheDocument();
    expectNothingSentHome();
  });

  it('deletes a role on that instance, never at home', async () => {
    await actor.click(screen.getByRole('button', { name: 'Helpers' }));
    await actor.click(screen.getByRole('button', { name: 'Delete Role' }));
    await actor.click(screen.getByRole('button', { name: 'Confirm?' }));
    expect(roles.delete).toHaveBeenCalledWith(SPACE_ID, 'r-helper');
    expectNothingSentHome();
  });
});
