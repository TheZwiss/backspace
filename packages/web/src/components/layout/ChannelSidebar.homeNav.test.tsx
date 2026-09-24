import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HubUpdateState } from '../../stores/projectHubStore';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via the voice components and stores.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// The dot's source of truth has its own tests; here only what the sidebar
// does with each state matters.
const hubState = vi.hoisted(() => ({ state: 'current' as HubUpdateState }));
vi.mock('../../hooks/useHubUpdateState', () => ({
  useHubUpdateState: () => ({ state: hubState.state, version: '1.2.0' }),
}));

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { ChannelSidebar } from './ChannelSidebar';

const SELECTED = 'bg-interactive-selected';
const LABELS = { friends: 'Friends', explore: 'Explore', backspace: 'Backspace' } as const;

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <ChannelSidebar />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** The clickable row of a home item, found by its visible label. */
function homeItem(label: string): HTMLElement {
  const row = screen.getByText(label, { selector: 'span' }).parentElement;
  if (!row) throw new Error(`no row for ${label}`);
  return row;
}

function selectedItems(): string[] {
  return Object.entries(LABELS)
    .filter(([, label]) => homeItem(label).classList.contains(SELECTED))
    .map(([key]) => key);
}

beforeEach(() => {
  hubState.state = 'current';
  useChatStore.setState({ currentChannelId: null });
  useSpaceStore.setState({ spaces: [], currentSpaceId: null, channels: [], dmChannels: [] });
  useUIStore.setState({ showDms: true });
});

describe('ChannelSidebar home items', () => {
  it('selects only Explore on /explore', () => {
    renderAt('/explore');
    expect(selectedItems()).toEqual(['explore']);
  });

  it('selects only Backspace on /backspace', () => {
    renderAt('/backspace');
    expect(selectedItems()).toEqual(['backspace']);
  });

  it('selects only Friends on the DM home', () => {
    renderAt('/channels/@me');
    expect(selectedItems()).toEqual(['friends']);
  });

  it('selects none of them while a DM is open', () => {
    useChatStore.setState({ currentChannelId: 'dm-1' });
    renderAt('/channels/@me/dm-1');
    expect(selectedItems()).toEqual([]);
  });

  it('navigates to /backspace when the Backspace item is clicked', () => {
    renderAt('/channels/@me');
    fireEvent.click(homeItem(LABELS.backspace));
    expect(screen.getByTestId('location')).toHaveTextContent('/backspace');
  });

  it('no longer renders the Coming Soon placeholder', () => {
    renderAt('/channels/@me');
    expect(screen.queryByText('Coming Soon')).toBeNull();
  });

  it('shows the updated dot when the instance updated since the last visit', () => {
    hubState.state = 'updated';
    renderAt('/channels/@me');
    const dot = screen.getByRole('img', { name: 'Backspace was updated' });
    expect(homeItem(LABELS.backspace)).toContainElement(dot);
  });

  it.each<HubUpdateState>(['unknown', 'first-run', 'current'])('shows no dot when the state is %s', (state) => {
    hubState.state = state;
    renderAt('/channels/@me');
    expect(screen.queryByRole('img', { name: 'Backspace was updated' })).toBeNull();
  });
});
