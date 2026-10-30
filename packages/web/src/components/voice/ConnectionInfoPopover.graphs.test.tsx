import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionInfoPopover } from './ConnectionInfoPopover';

const state = vi.hoisted(() => ({ room: {} as object | null, stats: null as any }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../../hooks/useLiveKit', () => ({ getActiveRoom: () => state.room }));
vi.mock('../../hooks/useTrackStats', () => ({ useTrackStats: () => state.stats }));
vi.mock('../../hooks/useFloatingPosition', () => ({ useFloatingPosition: () => ({ style: {} }) }));
vi.mock('../../hooks/usePortalContainer', () => ({ usePortalContainer: () => document.body }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('connection graphs', () => {
  it('plots real samples, leaves gaps for missing values and clears history when closed', () => {
    const anchorRef = { current: null };
    const snapshot = (ping: number | null) => ({ network: { ping, packetLoss: 0, jitter: null, serverAddress: null, protocol: null, candidateType: null }, audioTracks: [], videoTracks: [] });
    state.stats = snapshot(30);
    const view = render(<ConnectionInfoPopover open onClose={() => {}} anchorRef={anchorRef} />);
    expect(screen.getByText('voice:connectionInfo.network.ping')).toBeTruthy();
    expect(document.querySelectorAll('svg circle')).toHaveLength(2);
    state.stats = snapshot(40);
    view.rerender(<ConnectionInfoPopover open onClose={() => {}} anchorRef={anchorRef} />);
    expect(document.querySelectorAll('svg polyline')).toHaveLength(2);
    state.stats = snapshot(null);
    view.rerender(<ConnectionInfoPopover open onClose={() => {}} anchorRef={anchorRef} />);
    state.stats = snapshot(50);
    view.rerender(<ConnectionInfoPopover open onClose={() => {}} anchorRef={anchorRef} />);
    expect(document.querySelectorAll('svg polyline')).toHaveLength(2);
    expect(document.querySelectorAll('svg circle')).toHaveLength(1);
    view.rerender(<ConnectionInfoPopover open={false} onClose={() => {}} anchorRef={anchorRef} />);
    state.stats = snapshot(20);
    view.rerender(<ConnectionInfoPopover open onClose={() => {}} anchorRef={anchorRef} />);
    expect(document.querySelectorAll('svg polyline')).toHaveLength(0);
  });
});
