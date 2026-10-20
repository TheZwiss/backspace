import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { User, DmChannel } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { DmRosterPanel } from './DmRosterPanel';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { useSocialStore } from '../../stores/socialStore';
import { RIGHT_PANEL_DEFAULT_WIDTH, RIGHT_PANEL_MAX_WIDTH } from '../../utils/rightPanelResize';
import { dragBorder } from '../../test/pointerDrag';

// The group-DM roster shares the right column with the space member list, so
// the same drag handle must resize it from the same persisted uiStore width.

const DM_ID = 'dm-1';

function user(id: string, name: string): User {
  return {
    id, username: name.toLowerCase(), displayName: name, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null,
    replicatedInstances: [],
  };
}

const GROUP_DM: DmChannel = {
  id: DM_ID,
  federatedId: null,
  ownerId: 'owner',
  ownerHomeUserId: null,
  ownerHomeInstance: null,
  createdAt: 1,
  members: [user('owner', 'Olga'), user('lead', 'Lena'), user('mate', 'Mia')],
  lastMessage: null,
  name: null,
  icon: null,
  metadataUpdatedAt: 1,
};

beforeEach(() => {
  useAuthStore.setState({ user: user('lead', 'Lena') });
  useChatStore.setState({ currentChannelId: DM_ID });
  useSpaceStore.setState({
    dmChannels: [GROUP_DM],
    currentSpaceId: null,
    channelOriginMap: new Map(),
  });
  useSocialStore.setState({ friends: [] });
  useUIStore.setState({
    isMobile: false,
    showDms: true,
    memberListOpen: true,
    rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,
    activeModal: null,
    modalData: {},
    userProfilePopout: { user: null, origin: '', anchor: null, placement: 'right', member: null },
  });
});

describe('DmRosterPanel: drag-to-resize', () => {
  it('renders the resize handle for a group DM, carrying the shared width range', () => {
    render(<MemoryRouter><DmRosterPanel /></MemoryRouter>);
    const handle = screen.getByRole('separator', { name: 'Resize member list' });
    expect(handle.parentElement).toHaveAttribute('data-dm-roster-panel');
    expect(handle).toHaveAttribute('aria-valuenow', String(RIGHT_PANEL_DEFAULT_WIDTH));
  });

  it('widens the shared right-column width while the border is dragged left', () => {
    render(<MemoryRouter><DmRosterPanel /></MemoryRouter>);
    dragBorder(500, 440);
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH + 60);
  });

  it('clamps the shared width at the configured maximum', () => {
    render(<MemoryRouter><DmRosterPanel /></MemoryRouter>);
    dragBorder(500, -4000);
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MAX_WIDTH);
  });

  it('restores the default width on double-click', () => {
    useUIStore.setState({ rightPanelWidth: 333 });
    render(<MemoryRouter><DmRosterPanel /></MemoryRouter>);
    fireEvent.dblClick(screen.getByRole('separator'));
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
  });

  it('renders no handle for a 1-on-1 DM', () => {
    useSpaceStore.setState({
      dmChannels: [{ ...GROUP_DM, ownerId: null, ownerHomeUserId: null, ownerHomeInstance: null, members: [user('lead', 'Lena'), user('mate', 'Mia')] }],
    });
    render(<MemoryRouter><DmRosterPanel /></MemoryRouter>);
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('renders no handle when the member list toggle is off', () => {
    useUIStore.setState({ memberListOpen: false });
    render(<MemoryRouter><DmRosterPanel /></MemoryRouter>);
    expect(screen.queryByRole('separator')).toBeNull();
  });
});
