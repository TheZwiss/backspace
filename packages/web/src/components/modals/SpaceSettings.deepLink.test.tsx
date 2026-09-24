import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { InstanceStreamingLimits } from '@backspace/shared';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { MemoryRouter } from 'react-router-dom';
import { SpaceSettingsModal } from './SpaceSettings';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../api/client';
import { PermissionBits, permissionsToString } from '../../utils/permissions';

const SWITCH = 'List in the global Backspace directory';

const limits: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080],
  allowedFramerates: [30, 45, 60],
  maxResolution: 1080,
  maxFramerate: 60,
  discoveryEnabled: true,
  directoryEnabled: true,
  directoryConfigured: true,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
};

const space: TaggedSpace = {
  id: 'space-1',
  name: 'Aether Drift',
  icon: null,
  banner: null,
  avatarColor: 'lavender',
  ownerId: 'user-1',
  inviteCode: null,
  visibility: 'public',
  directoryListed: false,
  description: '',
  createdAt: 1,
  _instanceOrigin: '',
};

function seed(permissions: bigint): void {
  useSpaceStore.setState({
    spaces: [space],
    currentSpaceId: space.id,
    spacePermissions: new Map([[space.id, permissionsToString(permissions)]]),
  });
  useSettingsStore.setState({ streamingLimits: limits, isAdmin: false });
}

beforeEach(() => {
  vi.spyOn(api.explore, 'getJoinRequests').mockResolvedValue([]);
  useUIStore.setState({ activeModal: null, modalData: {}, isMobile: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SpaceSettingsModal opening tab', () => {
  it('opens on the tab the caller names', async () => {
    seed(PermissionBits.MANAGE_SPACE);
    render(<MemoryRouter><SpaceSettingsModal /></MemoryRouter>);
    act(() => { useUIStore.getState().openModal('spaceSettings', { tab: 'discovery' }); });
    await act(async () => {});
    expect(screen.getByRole('switch', { name: SWITCH })).toBeInTheDocument();
  });

  it('falls back to the overview when the named tab is not this user\'s to see', async () => {
    seed(0n);
    render(<MemoryRouter><SpaceSettingsModal /></MemoryRouter>);
    act(() => { useUIStore.getState().openModal('spaceSettings', { tab: 'discovery' }); });
    await act(async () => {});
    expect(screen.queryByRole('switch', { name: SWITCH })).not.toBeInTheDocument();
  });

  it('opens on the overview when no tab is named', async () => {
    seed(PermissionBits.MANAGE_SPACE);
    render(<MemoryRouter><SpaceSettingsModal /></MemoryRouter>);
    act(() => { useUIStore.getState().openModal('spaceSettings'); });
    await act(async () => {});
    expect(screen.queryByRole('switch', { name: SWITCH })).not.toBeInTheDocument();
  });
});
