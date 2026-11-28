import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { ActivityPanel } from './ActivityPanel';
import { useUIStore } from '../../stores/uiStore';
import { useSocialStore, type TaggedFriend } from '../../stores/socialStore';
import { RIGHT_PANEL_DEFAULT_WIDTH, RIGHT_PANEL_MIN_WIDTH } from '../../utils/rightPanelResize';
import { dragBorder } from '../../test/pointerDrag';

// The friends activity list shares the right column with the space member
// list and the group-DM roster, so the same drag handle resizes it from the
// same persisted uiStore width.

function friend(id: string, name: string): TaggedFriend {
  return {
    id, username: name.toLowerCase(), displayName: name, avatar: null, banner: null,
    accentColor: null, avatarColor: null, bio: null, status: 'online', customStatus: null,
    createdAt: 1, addedAt: 1, homeUserId: null, homeInstance: null, _instanceOrigin: '',
  };
}

beforeEach(() => {
  // The panel loads friends on mount; a no-op keeps the fixture state the
  // only source of truth in this file.
  useSocialStore.setState({
    friends: [friend('f-1', 'Olga'), friend('f-2', 'Mia')],
    loadFriends: () => Promise.resolve(),
  });
  useUIStore.setState({
    isMobile: false,
    memberListOpen: true,
    rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,
    activeModal: null,
    modalData: {},
    userProfilePopout: { user: null, origin: '', anchor: null, placement: 'right', member: null },
  });
});

describe('ActivityPanel: drag-to-resize', () => {
  it('renders the resize handle for the friends list, carrying the shared width range', () => {
    render(<MemoryRouter><ActivityPanel /></MemoryRouter>);
    const handle = screen.getByRole('separator', { name: 'Resize friends list' });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuenow', String(RIGHT_PANEL_DEFAULT_WIDTH));
  });

  it('narrows the shared right-column width while the border is dragged right', () => {
    render(<MemoryRouter><ActivityPanel /></MemoryRouter>);
    dragBorder(500, 540);
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH - 40);
  });

  it('clamps the shared width at the configured minimum', () => {
    render(<MemoryRouter><ActivityPanel /></MemoryRouter>);
    dragBorder(500, 4000);
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('restores the default width on double-click', () => {
    useUIStore.setState({ rightPanelWidth: 333 });
    render(<MemoryRouter><ActivityPanel /></MemoryRouter>);
    fireEvent.dblClick(screen.getByRole('separator'));
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
  });

  it('renders no handle when the member list toggle is off', () => {
    useUIStore.setState({ memberListOpen: false });
    render(<MemoryRouter><ActivityPanel /></MemoryRouter>);
    expect(screen.queryByRole('separator')).toBeNull();
  });
});
