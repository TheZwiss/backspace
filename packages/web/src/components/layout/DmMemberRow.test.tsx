import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '@backspace/shared';

// Stub AudioManager — pulled in transitively via spaceStore from useCanonicalUserView.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Force desktop rendering in ContextMenuRenderer (mobile path triggers
// document-level long-press listeners we don't need here).
// DmMemberRow now anchors the profile popout itself via
// `useUIStore.getState().openUserProfile(...)`, so we expose a real `getState`
// hook that the test below asserts against.
const openUserProfileMock = vi.fn();
const uiStoreState = { isMobile: false, openUserProfile: openUserProfileMock };
vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (s: typeof uiStoreState) => unknown) => selector(uiStoreState),
    {
      getState: () => uiStoreState,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

import { DmMemberRow, type DmMemberRowAction } from './DmMemberRow';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { useContextMenuStore } from '../../stores/contextMenuStore';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u-1',
    username: 'alice',
    displayName: 'Alice',
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

beforeEach(() => {
  // Make sure each test starts with no menu open.
  act(() => {
    useContextMenuStore.getState().close();
  });
  openUserProfileMock.mockClear();
});

function renderRow(props: Partial<Parameters<typeof DmMemberRow>[0]> = {}) {
  const onMenuAction = vi.fn<(action: DmMemberRowAction, member: User) => void>();
  const member = props.member ?? makeUser();
  const utils = render(
    <>
      <DmMemberRow
        member={member}
        isOwner={props.isOwner ?? false}
        isSelf={props.isSelf ?? false}
        callerIsOwner={props.callerIsOwner ?? false}
        isFriend={props.isFriend ?? false}
        showKebab={props.showKebab ?? false}
        onMenuAction={props.onMenuAction ?? onMenuAction}
      />
      <ContextMenuRenderer />
    </>,
  );
  return { ...utils, onMenuAction, member };
}

function openMenuByContextMenu(target: HTMLElement) {
  fireEvent.contextMenu(target, { clientX: 100, clientY: 100 });
}

function getMenuLabels(): string[] {
  // Menu items render as <button> elements inside the portal.
  // Use the action-button class fingerprint via role lookup.
  const buttons = document.querySelectorAll<HTMLButtonElement>('div.fixed.z-\\[200\\] button');
  return Array.from(buttons).map((b) => b.textContent?.trim() ?? '');
}

describe('DmMemberRow — menu visibility', () => {
  it('owner caller, friend non-self → Profile + Transfer + Remove from Group + (sep) Remove Friend', () => {
    const { container } = renderRow({
      callerIsOwner: true,
      isSelf: false,
      isFriend: true,
    });
    openMenuByContextMenu(container.querySelector('[data-dm-member-row]')!);
    const labels = getMenuLabels();
    expect(labels).toEqual([
      'View Profile',
      'Transfer Ownership',
      'Remove from Group',
      'Remove Friend',
    ]);
    // Separator should be present between kick and remove-friend.
    const separators = document.querySelectorAll('div.fixed.z-\\[200\\] > div.h-px');
    expect(separators.length).toBe(1);
  });

  it('owner caller, viewing self → Profile only', () => {
    const { container } = renderRow({
      callerIsOwner: true,
      isSelf: true,
      isFriend: true,
    });
    openMenuByContextMenu(container.querySelector('[data-dm-member-row]')!);
    expect(getMenuLabels()).toEqual(['View Profile']);
  });

  it('owner caller, non-friend non-self → Profile + Transfer + Remove from Group (no separator, no Remove Friend)', () => {
    const { container } = renderRow({
      callerIsOwner: true,
      isSelf: false,
      isFriend: false,
    });
    openMenuByContextMenu(container.querySelector('[data-dm-member-row]')!);
    expect(getMenuLabels()).toEqual([
      'View Profile',
      'Transfer Ownership',
      'Remove from Group',
    ]);
    const separators = document.querySelectorAll('div.fixed.z-\\[200\\] > div.h-px');
    expect(separators.length).toBe(0);
  });

  it('non-owner caller, friend non-self → Profile + Remove Friend (no Transfer, no Kick, no separator)', () => {
    const { container } = renderRow({
      callerIsOwner: false,
      isSelf: false,
      isFriend: true,
    });
    openMenuByContextMenu(container.querySelector('[data-dm-member-row]')!);
    expect(getMenuLabels()).toEqual(['View Profile', 'Remove Friend']);
    const separators = document.querySelectorAll('div.fixed.z-\\[200\\] > div.h-px');
    expect(separators.length).toBe(0);
  });

  it('non-owner caller, non-friend non-self → Profile only', () => {
    const { container } = renderRow({
      callerIsOwner: false,
      isSelf: false,
      isFriend: false,
    });
    openMenuByContextMenu(container.querySelector('[data-dm-member-row]')!);
    expect(getMenuLabels()).toEqual(['View Profile']);
  });
});

describe('DmMemberRow — visual markers', () => {
  it('renders the federation globe + @domain subtitle for federated members', () => {
    const federated = makeUser({
      id: 'u-fed',
      username: 'bob@orbit.example',
      homeInstance: 'orbit.example',
    });
    const { container } = renderRow({ member: federated });
    expect(container.querySelector('[data-federation-globe]')).toBeTruthy();
    // Subtitle "@orbit.example"
    expect(container.textContent).toContain('@orbit.example');
  });

  it('does NOT render the globe for native members', () => {
    const { container } = renderRow({ member: makeUser() });
    expect(container.querySelector('[data-federation-globe]')).toBeFalsy();
  });

  it('renders the owner crown when isOwner=true', () => {
    const { container } = renderRow({ isOwner: true });
    expect(container.querySelector('[data-owner-crown]')).toBeTruthy();
  });

  it('does NOT render the crown when isOwner=false', () => {
    const { container } = renderRow({ isOwner: false });
    expect(container.querySelector('[data-owner-crown]')).toBeFalsy();
  });
});

describe('DmMemberRow — kebab', () => {
  it('hides the kebab when showKebab=false (default)', () => {
    const { container } = renderRow();
    expect(container.querySelector('[data-dm-member-kebab]')).toBeFalsy();
  });

  it('shows the kebab when showKebab=true and clicking it opens the same menu', async () => {
    const user = userEvent.setup();
    const { container } = renderRow({
      showKebab: true,
      callerIsOwner: true,
      isFriend: true,
    });
    const kebab = container.querySelector<HTMLButtonElement>('[data-dm-member-kebab]');
    expect(kebab).toBeTruthy();

    await user.click(kebab!);

    expect(getMenuLabels()).toEqual([
      'View Profile',
      'Transfer Ownership',
      'Remove from Group',
      'Remove Friend',
    ]);
  });
});

describe('DmMemberRow — onMenuAction', () => {
  it('invokes onMenuAction with the correct action key when an item is clicked', async () => {
    const user = userEvent.setup();
    const { container, onMenuAction, member } = renderRow({
      callerIsOwner: true,
      isSelf: false,
      isFriend: true,
    });
    openMenuByContextMenu(container.querySelector('[data-dm-member-row]')!);

    const transferBtn = await screen.findByText('Transfer Ownership');
    await user.click(transferBtn);

    expect(onMenuAction).toHaveBeenCalledTimes(1);
    expect(onMenuAction).toHaveBeenCalledWith('transfer', expect.objectContaining({ id: member.id }));
  });
});

describe('DmMemberRow — profile popout anchoring', () => {
  it('anchors openUserProfile to the row bounding rect (matches MemberSidebar pattern)', async () => {
    const user = userEvent.setup();
    const { container, onMenuAction, member } = renderRow();
    const row = container.querySelector('[data-dm-member-row]') as HTMLElement;

    // Stub the row's getBoundingClientRect so we get a stable anchor target.
    const rect: DOMRect = {
      top: 200,
      left: 1500,
      right: 1740,
      bottom: 240,
      width: 240,
      height: 40,
      x: 1500,
      y: 200,
      toJSON: () => ({}),
    } as DOMRect;
    row.getBoundingClientRect = () => rect;

    // jsdom defaults innerHeight to 768; make sure that matters for the math.
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    openMenuByContextMenu(row);
    const profileBtn = await screen.findByText('View Profile');
    await user.click(profileBtn);

    expect(openUserProfileMock).toHaveBeenCalledTimes(1);
    expect(openUserProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: member.id }),
      // Math.min(200, 800 - 450) = 200; left = 1500 - 316 = 1184.
      { top: 200, left: 1184 },
    );
    // The row no longer routes 'profile' through onMenuAction.
    expect(onMenuAction).not.toHaveBeenCalled();
  });

  it('clamps top to (innerHeight - 450) when the row sits near the bottom of the viewport', async () => {
    const user = userEvent.setup();
    const { container } = renderRow();
    const row = container.querySelector('[data-dm-member-row]') as HTMLElement;

    const rect: DOMRect = {
      top: 700,
      left: 1500,
      right: 1740,
      bottom: 740,
      width: 240,
      height: 40,
      x: 1500,
      y: 700,
      toJSON: () => ({}),
    } as DOMRect;
    row.getBoundingClientRect = () => rect;

    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    openMenuByContextMenu(row);
    await user.click(await screen.findByText('View Profile'));

    // Math.min(700, 800 - 450 = 350) → top clamped to 350.
    expect(openUserProfileMock).toHaveBeenCalledWith(
      expect.anything(),
      { top: 350, left: 1184 },
    );
  });

  it('falls back to onMenuAction("profile", ...) when the row has no bounding rect', async () => {
    const user = userEvent.setup();
    const { container, onMenuAction, member } = renderRow();
    const row = container.querySelector('[data-dm-member-row]') as HTMLElement;

    // Simulate a missing rect — defensive fallback path.
    row.getBoundingClientRect = () => null as unknown as DOMRect;

    openMenuByContextMenu(row);
    await user.click(await screen.findByText('View Profile'));

    expect(openUserProfileMock).not.toHaveBeenCalled();
    expect(onMenuAction).toHaveBeenCalledTimes(1);
    expect(onMenuAction).toHaveBeenCalledWith('profile', expect.objectContaining({ id: member.id }));
  });
});
