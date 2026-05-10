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
vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: { isMobile: boolean; openUserProfile: () => void }) => unknown) =>
    selector({ isMobile: false, openUserProfile: () => {} }),
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
