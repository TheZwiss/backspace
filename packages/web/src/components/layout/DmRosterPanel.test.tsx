import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User, DmChannel } from '@backspace/shared';

// ── Stubs / mocks ──────────────────────────────────────────────────────────

// AudioManager is pulled in transitively via spaceStore — avoid AudioWorkletNode.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Mutable selector-state holders so individual tests can flip caller / channel
// shape without rebuilding the whole module mock graph.
type ChatStateShape = { currentChannelId: string | null };
type SpaceStateShape = { dmChannels: DmChannel[]; currentSpaceId: string | null; userViews: Map<string, unknown> };
type UIStateShape = {
  memberListOpen: boolean;
  showDms: boolean;
  isMobile: boolean;
  openUserProfile: ReturnType<typeof vi.fn>;
  addToast: ReturnType<typeof vi.fn>;
};
type AuthStateShape = { user: User | null };
type SocialStateShape = { friends: { id: string }[]; removeFriend: ReturnType<typeof vi.fn> };

const chatState: ChatStateShape = { currentChannelId: 'dm-1' };
const spaceState: SpaceStateShape = {
  dmChannels: [],
  currentSpaceId: null,
  userViews: new Map(),
};
const uiState: UIStateShape = {
  memberListOpen: true,
  showDms: true,
  isMobile: false,
  openUserProfile: vi.fn(),
  addToast: vi.fn(),
};
const authState: AuthStateShape = { user: null };
const socialState: SocialStateShape = { friends: [], removeFriend: vi.fn() };

vi.mock('../../stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: ChatStateShape) => unknown) => selector(chatState),
    {
      getState: () => chatState,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (s: SpaceStateShape) => unknown) => selector(spaceState),
    {
      getState: () => spaceState,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (s: UIStateShape) => unknown) => selector(uiState),
    {
      getState: () => uiState,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: AuthStateShape) => unknown) => selector(authState),
    {
      getState: () => authState,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../stores/socialStore', () => ({
  useSocialStore: Object.assign(
    (selector: (s: SocialStateShape) => unknown) => selector(socialState),
    {
      getState: () => socialState,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

// API client — both owner-only methods are stubbed; calls return success by default.
const apiKickMember = vi.fn().mockResolvedValue({ success: true });
const apiTransferOwnership = vi.fn().mockResolvedValue({});
vi.mock('../../api/client', () => ({
  api: {
    dm: {
      kickMember: (
        channelId: string,
        userId: string,
        federated?: { homeUserId: string; homeInstance: string },
      ) => apiKickMember(channelId, userId, federated),
      transferOwnership: (
        channelId: string,
        userId: string,
        federated?: { homeUserId: string; homeInstance: string },
      ) => apiTransferOwnership(channelId, userId, federated),
    },
  },
}));

// useCanonicalUserView falls back to the input on cache miss; that's exactly
// what we want here.

// ── Imports under test ─────────────────────────────────────────────────────

import { DmRosterPanel } from './DmRosterPanel';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { useContextMenuStore } from '../../stores/contextMenuStore';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u-default',
    username: 'someone',
    displayName: null,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 0,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
    ...overrides,
  };
}

function makeGroupDm(members: User[], ownerId: string): DmChannel {
  return {
    id: 'dm-1',
    federatedId: null,
    ownerId,
    ownerHomeUserId: null,
    ownerHomeInstance: null,
    createdAt: 0,
    members,
    lastMessage: null,
    name: null,
    icon: null,
    metadataUpdatedAt: 0,
  };
}

function setScenario(opts: {
  caller: User;
  members: User[];
  ownerId: string;
  isGroupDm?: boolean;
  memberListOpen?: boolean;
  showDms?: boolean;
  currentSpaceId?: string | null;
  friends?: { id: string }[];
  channelId?: string | null;
}) {
  authState.user = opts.caller;
  uiState.memberListOpen = opts.memberListOpen ?? true;
  uiState.showDms = opts.showDms ?? true;
  spaceState.currentSpaceId = opts.currentSpaceId ?? null;
  spaceState.dmChannels = opts.isGroupDm === false
    ? []
    : [makeGroupDm(opts.members, opts.ownerId)];
  // Also support 1-on-1 case: caller passes isGroupDm=false → no channel.
  if (opts.isGroupDm === false) {
    spaceState.dmChannels = [{
      ...makeGroupDm(opts.members, opts.ownerId),
      ownerId: null,
    }];
  }
  chatState.currentChannelId = opts.channelId === undefined ? 'dm-1' : opts.channelId;
  socialState.friends = opts.friends ?? [];
}

beforeEach(() => {
  // Reset shared state before every test.
  authState.user = null;
  spaceState.dmChannels = [];
  spaceState.currentSpaceId = null;
  spaceState.userViews = new Map();
  uiState.memberListOpen = true;
  uiState.showDms = true;
  uiState.isMobile = false;
  uiState.openUserProfile = vi.fn();
  uiState.addToast = vi.fn();
  chatState.currentChannelId = 'dm-1';
  socialState.friends = [];
  socialState.removeFriend = vi.fn().mockResolvedValue(undefined);
  apiKickMember.mockClear().mockResolvedValue({ success: true });
  apiTransferOwnership.mockClear().mockResolvedValue({});

  act(() => {
    useContextMenuStore.getState().close();
  });
});

function renderPanel() {
  return render(
    <>
      <DmRosterPanel />
      <ContextMenuRenderer />
    </>,
  );
}

function getMenuLabels(): string[] {
  const buttons = document.querySelectorAll<HTMLButtonElement>('div.fixed.z-\\[200\\] button');
  return Array.from(buttons).map((b) => b.textContent?.trim() ?? '');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DmRosterPanel — visibility gates', () => {
  it('renders nothing when memberListOpen is false', () => {
    const owner = makeUser({ id: 'owner-1', username: 'owner' });
    setScenario({ caller: owner, members: [owner], ownerId: 'owner-1', memberListOpen: false });
    const { container } = renderPanel();
    expect(container.querySelector('[data-dm-roster-panel]')).toBeFalsy();
  });

  it('renders nothing when current channel is not a group DM', () => {
    const caller = makeUser({ id: 'me' });
    setScenario({
      caller,
      members: [caller],
      ownerId: 'me',
      isGroupDm: false,
    });
    const { container } = renderPanel();
    expect(container.querySelector('[data-dm-roster-panel]')).toBeFalsy();
  });

  it('renders nothing when not in DM view (currentSpaceId set + showDms=false)', () => {
    const owner = makeUser({ id: 'owner-1' });
    setScenario({
      caller: owner,
      members: [owner],
      ownerId: 'owner-1',
      showDms: false,
      currentSpaceId: 'space-1',
    });
    const { container } = renderPanel();
    expect(container.querySelector('[data-dm-roster-panel]')).toBeFalsy();
  });

  it('renders the panel for a group DM with member list open', () => {
    const owner = makeUser({ id: 'owner-1', username: 'owner', displayName: 'Owner' });
    setScenario({ caller: owner, members: [owner], ownerId: 'owner-1' });
    const { container } = renderPanel();
    expect(container.querySelector('[data-dm-roster-panel]')).toBeTruthy();
    expect(container.querySelector('[data-dm-roster-header]')?.textContent).toContain('Members — 1');
  });
});

describe('DmRosterPanel — section grouping', () => {
  it('groups members into OWNER + ONLINE + OFFLINE sections', () => {
    const owner = makeUser({ id: 'o', username: 'owner', displayName: 'Owner', status: 'online' });
    const onlineA = makeUser({ id: 'a', username: 'alice', displayName: 'Alice', status: 'online' });
    const onlineB = makeUser({ id: 'b', username: 'bob', displayName: 'Bob', status: 'online' });
    const offline = makeUser({ id: 'z', username: 'zoe', displayName: 'Zoe', status: 'offline' });

    setScenario({
      caller: makeUser({ id: 'me' }),
      members: [owner, onlineB, onlineA, offline],
      ownerId: 'o',
    });
    const { container } = renderPanel();

    expect(container.querySelector('[data-dm-roster-section="owner"]')).toBeTruthy();
    expect(container.querySelector('[data-dm-roster-section="online"]')).toBeTruthy();
    expect(container.querySelector('[data-dm-roster-section="offline"]')).toBeTruthy();
    expect(container.querySelector('[data-dm-roster-header]')?.textContent).toContain('Members — 4');
  });

  it('sorts ONLINE and OFFLINE alphabetically by displayName', () => {
    const owner = makeUser({ id: 'o', username: 'zzz-owner', displayName: 'Owner' });
    const charlie = makeUser({ id: 'c', username: 'c', displayName: 'Charlie', status: 'online' });
    const alice = makeUser({ id: 'a', username: 'a', displayName: 'Alice', status: 'online' });
    const bob = makeUser({ id: 'b', username: 'b', displayName: 'Bob', status: 'online' });

    setScenario({
      caller: makeUser({ id: 'me' }),
      members: [owner, charlie, alice, bob],
      ownerId: 'o',
    });
    const { container } = renderPanel();
    const onlineSection = container.querySelector('[data-dm-roster-section="online"]')!;
    const rows = onlineSection.querySelectorAll('[data-dm-member-row]');
    const names = Array.from(rows).map((r) => r.getAttribute('data-user-id'));
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('hides empty ONLINE / OFFLINE sections', () => {
    const owner = makeUser({ id: 'o', displayName: 'Solo' });
    setScenario({ caller: owner, members: [owner], ownerId: 'o' });
    const { container } = renderPanel();
    expect(container.querySelector('[data-dm-roster-section="online"]')).toBeFalsy();
    expect(container.querySelector('[data-dm-roster-section="offline"]')).toBeFalsy();
  });
});

describe('DmRosterPanel — action wiring', () => {
  it('kick action: opens confirm dialog, then calls api.dm.kickMember on confirm', async () => {
    const u = userEvent.setup();
    const owner = makeUser({ id: 'me', username: 'me', displayName: 'Me' });
    const target = makeUser({ id: 'tgt', username: 'tgt', displayName: 'Tgt' });

    setScenario({ caller: owner, members: [owner, target], ownerId: 'me' });
    const { container } = renderPanel();

    // Open menu via right-click on the target's row.
    const targetRow = container.querySelector(
      '[data-dm-roster-section="online"] [data-dm-member-row]',
    ) as HTMLElement;
    expect(targetRow).toBeTruthy();
    targetRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));

    const kickBtn = await screen.findByText('Remove from Group');
    await u.click(kickBtn);

    // Confirm dialog visible.
    const confirmBtn = await screen.findByRole('button', { name: 'Remove' });
    await u.click(confirmBtn);

    await waitFor(() => {
      expect(apiKickMember).toHaveBeenCalledTimes(1);
    });
    // Local target → federated arg is undefined.
    expect(apiKickMember).toHaveBeenCalledWith('dm-1', 'tgt', undefined);
  });

  it('transfer action: opens confirm dialog, then calls api.dm.transferOwnership on confirm', async () => {
    const u = userEvent.setup();
    const owner = makeUser({ id: 'me', username: 'me', displayName: 'Me' });
    const target = makeUser({ id: 'tgt', username: 'tgt', displayName: 'Tgt' });
    setScenario({ caller: owner, members: [owner, target], ownerId: 'me' });
    const { container } = renderPanel();

    const targetRow = container.querySelector(
      '[data-dm-roster-section="online"] [data-dm-member-row]',
    ) as HTMLElement;
    targetRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));

    const transferBtn = await screen.findByText('Transfer Ownership');
    await u.click(transferBtn);

    const confirmBtn = await screen.findByRole('button', { name: 'Transfer' });
    await u.click(confirmBtn);

    await waitFor(() => {
      expect(apiTransferOwnership).toHaveBeenCalledTimes(1);
    });
    // Local target → federated arg is undefined.
    expect(apiTransferOwnership).toHaveBeenCalledWith('dm-1', 'tgt', undefined);
  });

  it('remove-friend action: calls socialStore.removeFriend with the row user id', async () => {
    const u = userEvent.setup();
    const me = makeUser({ id: 'me' });
    const friend = makeUser({ id: 'friend-1', username: 'friend', displayName: 'Friend' });
    setScenario({
      caller: me,
      members: [me, friend],
      ownerId: 'someone-else', // caller is not owner
      friends: [{ id: 'friend-1' }],
    });
    const { container } = renderPanel();

    // Find the friend's row in the online section.
    const onlineSection = container.querySelector('[data-dm-roster-section="online"]')!;
    const rows = onlineSection.querySelectorAll('[data-dm-member-row]');
    const friendRow = Array.from(rows).find(
      (r) => r.getAttribute('data-user-id') === 'friend-1',
    ) as HTMLElement;
    expect(friendRow).toBeTruthy();
    friendRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));

    const removeBtn = await screen.findByText('Remove Friend');
    await u.click(removeBtn);

    await waitFor(() => {
      expect(socialState.removeFriend).toHaveBeenCalledWith('friend-1');
    });
  });

  it('profile action: calls openUserProfile with the row user', async () => {
    const u = userEvent.setup();
    const me = makeUser({ id: 'me' });
    const other = makeUser({ id: 'other', username: 'other', displayName: 'Other' });
    setScenario({ caller: me, members: [me, other], ownerId: 'me' });

    const { container } = renderPanel();

    const targetRow = container.querySelector(
      '[data-dm-roster-section="online"] [data-dm-member-row]',
    ) as HTMLElement;
    targetRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));

    const profileBtn = await screen.findByText('View Profile');
    await u.click(profileBtn);

    expect(uiState.openUserProfile).toHaveBeenCalledTimes(1);
    expect(uiState.openUserProfile.mock.calls[0]![0]).toEqual(expect.objectContaining({ id: 'other' }));
  });
});

describe('DmRosterPanel — caller permissions wiring', () => {
  it('non-owner caller does NOT see kick/transfer in any row menu', async () => {
    const me = makeUser({ id: 'me' });
    const owner = makeUser({ id: 'o', username: 'owner', displayName: 'Owner' });
    const other = makeUser({ id: 'o2', username: 'o2', displayName: 'O2' });
    setScenario({
      caller: me,
      members: [me, owner, other],
      ownerId: 'o',
    });
    const { container } = renderPanel();

    // Pick "other" row in the online section.
    const otherRow = Array.from(
      container.querySelectorAll('[data-dm-roster-section="online"] [data-dm-member-row]'),
    ).find((r) => r.getAttribute('data-user-id') === 'o2') as HTMLElement;
    act(() => {
      otherRow.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }),
      );
    });

    // Wait for the portal to render the menu, then assert on its label set.
    await screen.findByText('View Profile');
    const labels = getMenuLabels();
    expect(labels).not.toContain('Transfer Ownership');
    expect(labels).not.toContain('Remove from Group');
    expect(labels).toContain('View Profile');
  });

  it('owner caller sees kick + transfer for non-self rows', async () => {
    const me = makeUser({ id: 'me', username: 'me', displayName: 'Me' });
    const target = makeUser({ id: 'tgt', username: 'tgt', displayName: 'Tgt' });
    setScenario({ caller: me, members: [me, target], ownerId: 'me' });
    const { container } = renderPanel();

    const targetRow = container.querySelector(
      '[data-dm-roster-section="online"] [data-dm-member-row]',
    ) as HTMLElement;
    act(() => {
      targetRow.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }),
      );
    });

    await screen.findByText('Transfer Ownership');
    const labels = getMenuLabels();
    expect(labels).toContain('Transfer Ownership');
    expect(labels).toContain('Remove from Group');
  });
});
