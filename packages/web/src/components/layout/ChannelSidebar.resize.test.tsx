import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via the voice components and stores.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));
vi.mock('../../hooks/useHubUpdateState', () => ({
  useHubUpdateState: () => ({ state: 'current', version: '1.2.0' }),
}));

import { ChannelSidebar } from './ChannelSidebar';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import {
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
} from '../../utils/leftPanelResize';
import { firePointer, dragBorder } from '../../test/pointerDrag';

// The right border of the left column (space rail + channel/DM list) is a
// drag handle: dragging it right widens the column, dragging left narrows it,
// double-click restores the default, and the arrow keys resize it for
// keyboard users. Width lives in uiStore and is applied by AppLayout's grid
// track (desktop) and slide-in wrapper (below the desktop breakpoint).

const SPACE_ID = 'space-1';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

function renderSidebar(pathname = '/channels/@me') {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <ChannelSidebar />
    </MemoryRouter>,
  );
}

function seedHome(): void {
  useSpaceStore.setState({ spaces: [], currentSpaceId: null, channels: [], dmChannels: [] });
  useUIStore.setState({ showDms: true });
}

function seedSpace(): void {
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    loadingSpaceId: null,
    channels: [],
    categories: [],
    dmChannels: [],
    roles: [],
    members: [],
    spacePermissions: new Map(),
  });
  useUIStore.setState({ showDms: false });
}

beforeEach(() => {
  useChatStore.setState({ currentChannelId: null });
  useUIStore.setState({
    isMobile: false,
    leftPanelWidth: LEFT_PANEL_DEFAULT_WIDTH,
    activeModal: null,
    modalData: {},
  });
  seedHome();
});

describe('ChannelSidebar: drag-to-resize (left column)', () => {
  it('renders the resize handle as a labelled separator carrying the width range', () => {
    renderSidebar();
    const handle = screen.getByRole('separator', { name: 'Resize direct messages' });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuemin', String(LEFT_PANEL_MIN_WIDTH));
    expect(handle).toHaveAttribute('aria-valuemax', String(LEFT_PANEL_MAX_WIDTH));
    expect(handle).toHaveAttribute('aria-valuenow', String(LEFT_PANEL_DEFAULT_WIDTH));
  });

  it('labels the handle for the channel list while a space is open', () => {
    seedSpace();
    renderSidebar(`/channels/${SPACE_ID}`);
    const handle = screen.getByRole('separator', { name: 'Resize channel list' });
    expect(handle).toHaveAttribute('aria-valuenow', String(LEFT_PANEL_DEFAULT_WIDTH));
  });

  it('carries the stored width on the separator and follows live changes', () => {
    useUIStore.setState({ leftPanelWidth: 400 });
    renderSidebar();
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-valuenow', '400');
    act(() => {
      useUIStore.setState({ leftPanelWidth: 260 });
    });
    expect(handle).toHaveAttribute('aria-valuenow', '260');
  });

  it('widens the column while the border is dragged right, accumulating moves', () => {
    renderSidebar();
    const handle = screen.getByRole('separator');
    firePointer(handle, 'pointerdown', { pointerId: 7, clientX: 300 });
    firePointer(window, 'pointermove', { pointerId: 7, clientX: 330 });
    firePointer(window, 'pointermove', { pointerId: 7, clientX: 360 });
    firePointer(window, 'pointerup', { pointerId: 7 });
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH + 60);
  });

  it('narrows the column while the border is dragged left', () => {
    renderSidebar();
    dragBorder(300, 260);
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH - 40);
  });

  it('resizes the space view through the same handle and store', () => {
    seedSpace();
    renderSidebar(`/channels/${SPACE_ID}`);
    dragBorder(300, 340);
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH + 40);
  });

  it('locks the cursor for the drag and releases it on pointerup', () => {
    renderSidebar();
    const handle = screen.getByRole('separator');
    firePointer(handle, 'pointerdown', { pointerId: 7, clientX: 300 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    firePointer(window, 'pointermove', { pointerId: 7, clientX: 340 });
    firePointer(window, 'pointerup', { pointerId: 7 });
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH + 40);
  });

  it('clamps the drag at the configured bounds', () => {
    renderSidebar();
    dragBorder(300, 8000);
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_MAX_WIDTH);
    dragBorder(300, -8000);
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_MIN_WIDTH);
  });

  it('ignores move events from a pointer that did not start the drag', () => {
    renderSidebar();
    const handle = screen.getByRole('separator');
    firePointer(handle, 'pointerdown', { pointerId: 1, clientX: 300 });
    // A second finger sweeping across the column must not move the border.
    firePointer(window, 'pointermove', { pointerId: 99, clientX: 600 });
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH);
    firePointer(window, 'pointerup', { pointerId: 1 });
    expect(document.body.style.cursor).toBe('');
  });

  it('ignores non-primary-button presses', () => {
    renderSidebar();
    const handle = screen.getByRole('separator');
    firePointer(handle, 'pointerdown', { pointerId: 7, clientX: 300, button: 2 });
    firePointer(window, 'pointermove', { pointerId: 7, clientX: 700 });
    firePointer(window, 'pointerup', { pointerId: 7 });
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  it('restores the default width on double-click', () => {
    useUIStore.setState({ leftPanelWidth: 444 });
    renderSidebar();
    fireEvent.dblClick(screen.getByRole('separator'));
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  it('resizes by keyboard steps, with Shift for a bigger step, clamped at the floor', () => {
    renderSidebar();
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH + 16);
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH + 16 - 64);
    // The sidebar is mounted: route the direct store write through act so the
    // re-render it triggers is part of this test's act scope.
    act(() => {
      useUIStore.setState({ leftPanelWidth: LEFT_PANEL_MIN_WIDTH });
    });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_MIN_WIDTH);
  });
});
