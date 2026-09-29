import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { DmChannel, User } from '@backspace/shared';

/**
 * Every UI entry point that creates a DM hands the server's answer to the DM
 * merge module (`upsertDmCopy`) and navigates to the id it returns (ADR 0002,
 * migration step 8). Before, each one appended the answer by channel id, so a
 * conversation the client already showed from another instance got a second
 * row, and the UI opened the new one.
 *
 * `findExistingDmForUser` is a shortcut that saves the request; it does not
 * decide identity. These tests show a copy it cannot match (the other
 * instance lists bob under a local id the client cannot link to the bob it
 * knows), so the request goes out and the conversation key in the answer
 * decides.
 */

const auth = vi.hoisted(() => ({
  state: {
    user: { id: 'alice-home', username: 'alice', homeInstance: null as string | null, homeUserId: null as string | null },
    token: 't',
    myRowIds: new Map<string, string>(),
  },
}));

vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
  wsSendAll: vi.fn(),
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
vi.mock('../stores/authStore', async () =>
  (await import('../test/authStoreMock')).authStoreMock(() => auth.state));
vi.mock('../stores/instanceStore', async () => {
  const { create } = await import('zustand');
  const store = create<{ instances: unknown[] }>()(() => ({ instances: [] }));
  return { useInstanceStore: store };
});
vi.mock('../utils/mutuals', () => ({
  loadFederatedMutuals: vi.fn().mockResolvedValue({ mutualFriends: [], mutualSpaces: [] }),
}));
vi.mock('../hooks/useShownStatus', () => ({ useShownStatus: (_u: User, _origin: string, status: User['status']) => status }));
// `api/client` and `crossStoreResolvers` import each other, so the resolver
// module can hold the unmocked client; route the page's own origin to the
// mocked one, as `getApiForOrigin('')` does in the app.
const pageApi = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../utils/crossStoreResolvers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crossStoreResolvers')>();
  return {
    ...actual,
    getApiForOrigin: (origin: string) => (origin ? actual.getApiForOrigin(origin) : pageApi.client),
  };
});
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: {
    dm: { create: vi.fn(), createGroup: vi.fn(), addMember: vi.fn(), list: vi.fn() },
    social: { search: vi.fn() },
    users: { get: vi.fn() },
    uploads: { url: (k: string) => `/uploads/${k}` },
  },
}));

import { useSpaceStore } from '../stores/spaceStore';
import { setOriginFromHostnameResolver } from '../utils/crossStoreResolvers';
import { useChatStore } from '../stores/chatStore';
import { useUIStore } from '../stores/uiStore';
import { useSocialStore, type TaggedFriend } from '../stores/socialStore';
import { api } from '../api/client';
pageApi.client = api;
import { wireDm, copyDm } from '../test/dmWireShape';
import { UserProfilePopout } from './ui/UserProfilePopout';
import { UserProfileModal } from './modals/UserProfileModal';
import { NewDmModal } from './modals/NewDmModal';
import { AddDmMemberModal } from './modals/AddDmMemberModal';
import { DmSearchBar } from './layout/DmSearchBar';

const REMOTE = 'https://remote.example';
const FID_ALICE_BOB = 'fc8aa3239ccea0cd4cbfb7701d770ac9';

function user(id: string, homeUserId: string | null = null, homeInstance: string | null = null, username = id): User {
  return {
    id, username, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance, homeUserId, replicatedInstances: [],
  };
}

const aliceHome = user('alice-home', null, null, 'alice');
const aliceOnRemote = user('alice-on-remote', 'alice-home', 'home.example', 'alice');
/** bob as the home instance knows him: a replicated row naming his home identity. */
const bobOnHome = user('bob-stub-on-home', 'bob-remote', 'remote.example', 'bob');
/** bob in REMOTE's copy, under an id the client cannot link to `bobOnHome`. */
const bobUnlinkedOnRemote = user('bob-unlinked-remote', null, null, 'bob');

const bobDmRemote = wireDm({ id: 'dm-bob-remote', federatedId: FID_ALICE_BOB, createdAt: 2, members: [aliceOnRemote, bobUnlinkedOnRemote] });
const bobDmHome = wireDm({ id: 'dm-bob-home', federatedId: FID_ALICE_BOB, createdAt: 1, members: [aliceHome, bobOnHome] });

function rowIds(): string[] {
  return useSpaceStore.getState().dmChannels.map(d => d.id).sort();
}

let currentPath = '';
function recordPath(pathname: string): void {
  currentPath = pathname;
}
function PathProbe() {
  const { pathname } = useLocation();
  useEffect(() => recordPath(pathname), [pathname]);
  return null;
}

function renderAt(node: React.ReactNode, path = '/channels/@me') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<>{node}<PathProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.state.user = { id: 'alice-home', username: 'alice', homeInstance: null, homeUserId: null };
  setOriginFromHostnameResolver((host) => (host === 'remote.example' ? REMOTE : ''));
  // alice's account on REMOTE, as REMOTE's ready registers it.
  auth.state.myRowIds = new Map([[REMOTE, 'alice-on-remote']]);
  useSpaceStore.getState().reset();
  useChatStore.setState({ messages: new Map(), unreadChannels: new Set(), currentChannelId: null });
  useUIStore.setState({ activeModal: null, modalData: {}, isMobile: false });
  vi.mocked(api.dm.create).mockReset();
  vi.mocked(api.dm.createGroup).mockReset();
  vi.mocked(api.dm.addMember).mockReset();
  vi.mocked(api.social.search).mockReset();
  vi.mocked(api.users.get).mockReset();
  vi.mocked(api.users.get).mockResolvedValue(bobOnHome);
  currentPath = '';
  // The conversation is shown from REMOTE's copy; home's copy is not known yet.
  useSpaceStore.getState().populateFromReady(REMOTE, [], [], [copyDm(bobDmRemote)]);
  vi.mocked(api.dm.create).mockResolvedValue(copyDm(bobDmHome));
});

describe('a DM created from each UI entry point lands in the conversation\'s one row', () => {
  it('the profile popout\'s Send Message', async () => {
    renderAt(<UserProfilePopout user={bobOnHome} origin="" onClose={() => {}} anchor={{ top: 0, left: 0, right: 40, bottom: 40, width: 40, height: 40 }} />);

    await userEvent.click(screen.getByText('Send Message'));

    await waitFor(() => expect(currentPath).toBe('/channels/@me/dm-bob-home'));
    expect(rowIds()).toEqual(['dm-bob-home']);
  });

  it('the profile modal\'s Send Message', async () => {
    useUIStore.getState().openModal('userProfile', { userId: bobOnHome.id, user: bobOnHome, origin: '' });
    renderAt(<UserProfileModal />);

    await userEvent.click(screen.getByText('Send Message'));

    await waitFor(() => expect(currentPath).toBe('/channels/@me/dm-bob-home'));
    expect(rowIds()).toEqual(['dm-bob-home']);
  });

  it('the New DM modal', async () => {
    vi.mocked(api.social.search).mockResolvedValue([bobOnHome]);
    useUIStore.getState().openModal('newDm');
    renderAt(<NewDmModal />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bob' } });
    await userEvent.click(await screen.findByText('bob', {}, { timeout: 2000 }));

    await waitFor(() => expect(currentPath).toBe('/channels/@me/dm-bob-home'));
    expect(rowIds()).toEqual(['dm-bob-home']);
  });

  it('the DM search bar', async () => {
    vi.mocked(api.social.search).mockResolvedValue([bobOnHome]);
    renderAt(<DmSearchBar />);

    await userEvent.click(screen.getByRole('button'));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'bo' } });
    // bob appears once as a person to message (the listed copy does not name him recognisably).
    const results = await screen.findAllByText('bob', {}, { timeout: 2000 });
    await userEvent.click(results[results.length - 1]!);

    await waitFor(() => expect(currentPath).toBe('/channels/@me/dm-bob-home'));
    expect(rowIds()).toEqual(['dm-bob-home']);
  });

  it('the add-member modal: the new group gets one row and is opened', async () => {
    const carol: TaggedFriend = { ...user('carol-home', null, null, 'carol'), _instanceOrigin: '' } as TaggedFriend;
    useSocialStore.setState({ friends: [carol] });
    useSpaceStore.getState().populateFromReady('', [], [], [copyDm(bobDmHome)]);
    const group: DmChannel = wireDm({
      id: 'dm-group-new', ownerId: 'alice-home', createdAt: 9, members: [aliceHome, bobOnHome, user('carol-home')],
    });
    vi.mocked(api.dm.createGroup).mockResolvedValue(group);
    useUIStore.getState().openModal('addDmMember', { dmChannelId: 'dm-bob-home' });
    renderAt(<AddDmMemberModal />);

    await userEvent.click(screen.getByText('carol'));
    await userEvent.click(screen.getByText('Add 1 Friend'));

    await waitFor(() => expect(currentPath).toBe('/channels/@me/dm-group-new'));
    expect(rowIds()).toEqual(['dm-bob-home', 'dm-group-new']);
  });
});

describe('the add-member modal names the 1-on-1 by the id of the instance it asks', () => {
  it('sends home\'s copy id when the row is pinned to another instance\'s copy', async () => {
    // alice's account is homed on REMOTE, so REMOTE's copy is the pinned row;
    // the group is created through the browsed instance, which knows the
    // conversation only by its own id.
    auth.state.user = { id: 'alice-home', username: 'alice', homeInstance: 'remote.example', homeUserId: 'alice-true' };
    useSpaceStore.getState().reset();
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], [copyDm(bobDmRemote)]);
    useSpaceStore.getState().populateFromReady('', [], [], [copyDm(bobDmHome)]);
    expect(rowIds()).toEqual(['dm-bob-remote']);

    const carol: TaggedFriend = { ...user('carol-home', null, null, 'carol'), _instanceOrigin: '' } as TaggedFriend;
    useSocialStore.setState({ friends: [carol] });
    vi.mocked(api.dm.createGroup).mockResolvedValue(wireDm({
      id: 'dm-group-new', ownerId: 'alice-home', createdAt: 9, members: [aliceHome, bobOnHome, user('carol-home')],
    }));
    useUIStore.getState().openModal('addDmMember', { dmChannelId: 'dm-bob-remote' });
    renderAt(<AddDmMemberModal />);

    await userEvent.click(screen.getByText('carol'));
    await act(async () => {
      await userEvent.click(screen.getByText('Add 1 Friend'));
    });

    await waitFor(() => expect(api.dm.createGroup).toHaveBeenCalled());
    const request = vi.mocked(api.dm.createGroup).mock.calls[0]![0];
    expect(request.fromDmChannelId).toBe('dm-bob-home');
    // bob as home knows him, not REMOTE's local row for him.
    expect(request.users[0]).toEqual({ id: 'bob-stub-on-home', homeUserId: 'bob-remote', homeInstance: 'remote.example' });
  });

  it('sends no source id when the asked instance holds no copy of the conversation', async () => {
    const carol: TaggedFriend = { ...user('carol-home', null, null, 'carol'), _instanceOrigin: '' } as TaggedFriend;
    useSocialStore.setState({ friends: [carol] });
    vi.mocked(api.dm.createGroup).mockResolvedValue(wireDm({
      id: 'dm-group-new', ownerId: 'alice-home', createdAt: 9, members: [aliceHome, bobOnHome, user('carol-home')],
    }));
    useUIStore.getState().openModal('addDmMember', { dmChannelId: 'dm-bob-remote' });
    renderAt(<AddDmMemberModal />);

    await userEvent.click(screen.getByText('carol'));
    await userEvent.click(screen.getByText('Add 1 Friend'));

    await waitFor(() => expect(api.dm.createGroup).toHaveBeenCalled());
    const request = vi.mocked(api.dm.createGroup).mock.calls[0]![0];
    expect(request.fromDmChannelId).toBeUndefined();
    // bob is native to REMOTE: home resolves him by his home identity there.
    expect(request.users[0]).toEqual({ id: 'bob-unlinked-remote', homeUserId: 'bob-unlinked-remote', homeInstance: 'remote.example' });
  });
});

describe('the add-member modal adds to a group through home\'s copy of it', () => {
  const FID_GROUP = '0e0e0e0e-0000-4000-8000-000000000000';
  const groupRemote = wireDm({
    id: 'dm-group-remote', federatedId: FID_GROUP, ownerId: 'alice-on-remote', createdAt: 5,
    members: [aliceOnRemote, bobUnlinkedOnRemote],
  });
  const groupHome = wireDm({
    id: 'dm-group-home', federatedId: FID_GROUP, ownerId: 'alice-home', createdAt: 4,
    members: [aliceHome, bobOnHome],
  });
  const carol: TaggedFriend = { ...user('carol-home', null, null, 'carol'), _instanceOrigin: '' } as TaggedFriend;

  beforeEach(() => {
    // alice's account is homed on REMOTE, so REMOTE's copy is the pinned row.
    auth.state.user = { id: 'alice-home', username: 'alice', homeInstance: 'remote.example', homeUserId: 'alice-true' };
    useSpaceStore.getState().reset();
    useSocialStore.setState({ friends: [carol] });
    vi.mocked(api.dm.addMember).mockResolvedValue(copyDm(groupHome));
  });

  it('sends home\'s copy id when the row is pinned to another instance\'s copy', async () => {
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], [copyDm(groupRemote)]);
    useSpaceStore.getState().populateFromReady('', [], [], [copyDm(groupHome)]);
    expect(rowIds()).toEqual(['dm-group-remote']);
    useUIStore.getState().openModal('addDmMember', { dmChannelId: 'dm-group-remote' });
    renderAt(<AddDmMemberModal />);

    await userEvent.click(screen.getByText('carol'));
    await userEvent.click(screen.getByText('Add 1 Friend'));

    await waitFor(() => expect(api.dm.addMember).toHaveBeenCalled());
    expect(vi.mocked(api.dm.addMember).mock.calls[0]![0]).toBe('dm-group-home');
    expect(vi.mocked(api.dm.addMember).mock.calls[0]![1]).toEqual({ userId: 'carol-home', homeUserId: undefined, homeInstance: undefined });
  });

  it('when home holds no copy of the group it says so instead of sending another instance\'s id', async () => {
    useSpaceStore.getState().populateFromReady(REMOTE, [], [], [copyDm(groupRemote)]);
    useUIStore.getState().openModal('addDmMember', { dmChannelId: 'dm-group-remote' });
    renderAt(<AddDmMemberModal />);

    await userEvent.click(screen.getByText('carol'));
    await userEvent.click(screen.getByText('Add 1 Friend'));

    expect(await screen.findByText('Failed to add members')).toBeInTheDocument();
    expect(api.dm.addMember).not.toHaveBeenCalled();
  });
});
