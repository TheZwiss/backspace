import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DmChannel } from '@backspace/shared';

// RightPanel owns the right column (visibility, width, divider, surface) and
// picks its content. The content components are stubbed: their own tests
// cover what they render.
vi.mock('./MemberSidebar', () => ({ MemberSidebar: () => <div data-testid="member-sidebar" /> }));
vi.mock('./ActivityPanel', () => ({ ActivityPanel: () => <div data-testid="activity-panel" /> }));
vi.mock('./DmRosterPanel', () => ({ DmRosterPanel: () => <div data-testid="dm-roster" /> }));
// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { RightPanel } from './RightPanel';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { resolvePanelWidths } from '../../stores/panelWidths';

function dm(id: string, ownerId: string | null): DmChannel {
  return { id, ownerId } as DmChannel;
}

function setView(opts: { memberListOpen?: boolean; showDms?: boolean; spaceId?: string | null; channelId?: string; dms?: DmChannel[] }) {
  useUIStore.setState({
    memberListOpen: opts.memberListOpen ?? true,
    showDms: opts.showDms ?? false,
    panelWidths: resolvePanelWidths(),
  });
  useSpaceStore.setState({ currentSpaceId: opts.spaceId ?? null, dmChannels: opts.dms ?? [] });
  useChatStore.setState({ currentChannelId: opts.channelId ?? null });
}

const column = () => document.querySelector<HTMLElement>('[data-right-panel]');

describe('RightPanel', () => {
  beforeEach(() => setView({}));

  it('renders no column when the member list is toggled off', () => {
    setView({ memberListOpen: false, spaceId: 'space-1' });
    render(<RightPanel />);
    expect(column()).toBeNull();
    expect(screen.queryByTestId('member-sidebar')).toBeNull();
  });

  it('shows the member list in a space', () => {
    setView({ spaceId: 'space-1' });
    render(<RightPanel />);
    expect(screen.getByTestId('member-sidebar')).toBeTruthy();
    expect(column()?.className).toContain('bg-surface-members');
  });

  it('shows the roster for a group DM', () => {
    setView({ showDms: true, channelId: 'dm-1', dms: [dm('dm-1', 'owner')] });
    render(<RightPanel />);
    expect(screen.getByTestId('dm-roster')).toBeTruthy();
    expect(column()?.className).toContain('bg-surface-members');
  });

  it('shows the activity panel for a 1-on-1 DM and outside any channel', () => {
    setView({ showDms: true, channelId: 'dm-1', dms: [dm('dm-1', null)] });
    const { unmount } = render(<RightPanel />);
    expect(screen.getByTestId('activity-panel')).toBeTruthy();
    expect(column()?.className).toContain('bg-surface-channel');
    unmount();

    setView({ spaceId: null });
    render(<RightPanel />);
    expect(screen.getByTestId('activity-panel')).toBeTruthy();
  });

  it('treats showDms as the DM view even while a space is selected', () => {
    setView({ showDms: true, spaceId: 'space-1', channelId: 'dm-1', dms: [dm('dm-1', 'owner')] });
    render(<RightPanel />);
    expect(screen.getByTestId('dm-roster')).toBeTruthy();
  });

  it('sizes the column from the member list width and carries its divider', () => {
    setView({ spaceId: 'space-1' });
    useUIStore.getState().setPanelWidth('memberList', 300);
    render(<RightPanel />);
    expect(column()?.style.width).toBe('300px');
    expect(screen.getByRole('separator').getAttribute('data-panel-resizer')).toBe('memberList');
  });
});
