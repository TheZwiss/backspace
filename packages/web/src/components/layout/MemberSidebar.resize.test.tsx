import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { MemberWithUser, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { MemberSidebar } from './MemberSidebar';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
} from '../../utils/rightPanelResize';
import { firePointer, dragBorder } from '../../test/pointerDrag';

// The left border of the member list is a drag handle: dragging it left widens
// the panel, dragging right narrows it, double-click restores the default,
// and the arrow keys resize it for keyboard users. Width lives in uiStore.

const SPACE_ID = 'space-1';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

function user(id: string, name: string): User {
  return {
    id, username: name.toLowerCase(), displayName: name, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null,
    replicatedInstances: [],
  };
}

function member(id: string, name: string): MemberWithUser {
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id, name), roles: [] };
}

function seed(): void {
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    loadingSpaceId: null,
    roles: [],
    members: [member('owner', 'Olga'), member('lead', 'Lena')],
    spacePermissions: new Map(),
  });
}

beforeEach(() => {
  useAuthStore.setState({ user: user('lead', 'Lena') });
  useUIStore.setState({
    isMobile: false,
    memberListOpen: true,
    rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,
    activeModal: null,
    modalData: {},
    userProfilePopout: { user: null, origin: '', anchor: null, placement: 'right', member: null },
  });
  seed();
});

describe('MemberSidebar: drag-to-resize', () => {
  it('renders the resize handle as a labelled separator carrying the width range', () => {
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    const handle = screen.getByRole('separator', { name: 'Resize member list' });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuemin', String(RIGHT_PANEL_MIN_WIDTH));
    expect(handle).toHaveAttribute('aria-valuemax', String(RIGHT_PANEL_MAX_WIDTH));
    expect(handle).toHaveAttribute('aria-valuenow', String(RIGHT_PANEL_DEFAULT_WIDTH));
  });

  it('applies the stored width to the panel container', () => {
    useUIStore.setState({ rightPanelWidth: 300 });
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    const handle = screen.getByRole('separator');
    expect(handle.parentElement).toHaveStyle({ width: '300px' });
  });

  it('widens the panel while the border is dragged left, accumulating moves', () => {
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    const handle = screen.getByRole('separator');
    firePointer(handle, 'pointerdown', { pointerId: 7, clientX: 500 });
    firePointer(window, 'pointermove', { pointerId: 7, clientX: 470 });
    firePointer(window, 'pointermove', { pointerId: 7, clientX: 440 });
    firePointer(window, 'pointerup', { pointerId: 7 });
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH + 60);
  });

  it('narrows the panel while the border is dragged right', () => {
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    dragBorder(500, 540);
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH - 40);
  });

  it('locks the cursor for the drag and releases it on pointerup', () => {
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    const handle = screen.getByRole('separator');
    firePointer(handle, 'pointerdown', { pointerId: 7, clientX: 500 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    firePointer(window, 'pointermove', { pointerId: 7, clientX: 460 });
    firePointer(window, 'pointerup', { pointerId: 7 });
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH + 40);
  });

  it('clamps the drag at the configured bounds', () => {
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    dragBorder(500, -4000);
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MAX_WIDTH);
    dragBorder(500, 4000);
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('ignores move events from a pointer that did not start the drag', () => {
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    const handle = screen.getByRole('separator');
    firePointer(handle, 'pointerdown', { pointerId: 1, clientX: 500 });
    // A second finger sweeping across the panel must not move the border.
    firePointer(window, 'pointermove', { pointerId: 99, clientX: 300 });
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
    firePointer(window, 'pointerup', { pointerId: 1 });
    expect(document.body.style.cursor).toBe('');
  });

  it('ignores non-primary-button presses', () => {
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    const handle = screen.getByRole('separator');
    firePointer(handle, 'pointerdown', { pointerId: 7, clientX: 500, button: 2 });
    firePointer(window, 'pointermove', { pointerId: 7, clientX: 300 });
    firePointer(window, 'pointerup', { pointerId: 7 });
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
  });

  it('restores the default width on double-click', () => {
    useUIStore.setState({ rightPanelWidth: 333 });
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    fireEvent.dblClick(screen.getByRole('separator'));
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
  });

  it('resizes by keyboard steps, with Shift for a bigger step, clamped at the floor', () => {
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH + 16);
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_DEFAULT_WIDTH + 16 - 64);
    // The panel is mounted: route the direct store write through act so the
    // re-render it triggers is part of this test's act scope.
    act(() => {
      useUIStore.setState({ rightPanelWidth: RIGHT_PANEL_MIN_WIDTH });
    });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('renders no handle when the member list is toggled off', () => {
    useUIStore.setState({ memberListOpen: false });
    render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
    expect(screen.queryByRole('separator')).toBeNull();
  });
});
