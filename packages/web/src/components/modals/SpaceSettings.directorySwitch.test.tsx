import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

import { DiscoveryPanel } from './SpaceSettings';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { api } from '../../api/client';

const SWITCH = 'List in the Backspace directory';
const ADMIN_OFF = 'Your admin has to enable the directory for this instance.';
const PRIVATE_SPACE = 'Set visibility to public or request to join first.';

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

function seed(spaceOverrides: Partial<TaggedSpace>, directoryEnabled: boolean): void {
  useSpaceStore.setState({ spaces: [{ ...space, ...spaceOverrides }] });
  useSettingsStore.setState({ streamingLimits: { ...limits, directoryEnabled } });
}

function directorySwitch(): HTMLElement {
  return screen.getByRole('switch', { name: SWITCH });
}

const realUpdateSpace = useSpaceStore.getState().updateSpace;

/**
 * The panel must save through the store's `updateSpace`, which resolves the
 * space's own instance; the mock stands in for it so the assertion is on the
 * call the panel makes, not on whichever client the store would pick.
 */
function mockUpdateSpace(): ReturnType<typeof vi.fn> {
  const updateSpace = vi.fn().mockResolvedValue(undefined);
  useSpaceStore.setState({ updateSpace });
  return updateSpace;
}

beforeEach(() => {
  vi.spyOn(api.explore, 'getJoinRequests').mockResolvedValue({ requests: [] });
});

afterEach(() => {
  useSpaceStore.setState({ updateSpace: realUpdateSpace });
  vi.restoreAllMocks();
});

describe('DiscoveryPanel directory switch', () => {
  it('is rendered but disabled with the admin reason while the instance has the directory off', () => {
    seed({ visibility: 'public' }, false);
    render(<DiscoveryPanel spaceId="space-1" />);
    expect(directorySwitch()).toBeDisabled();
    expect(screen.getByText(ADMIN_OFF)).toBeInTheDocument();
    expect(screen.queryByText(PRIVATE_SPACE)).not.toBeInTheDocument();
  });

  it('is disabled with the visibility reason, and off, while the space is private', () => {
    seed({ visibility: 'private' }, true);
    render(<DiscoveryPanel spaceId="space-1" />);
    expect(directorySwitch()).toBeDisabled();
    expect(directorySwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(PRIVATE_SPACE)).toBeInTheDocument();
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();
  });

  it('is enabled with no reason for a public space on an instance that allows it', async () => {
    seed({ visibility: 'public' }, true);
    render(<DiscoveryPanel spaceId="space-1" />);
    expect(directorySwitch()).toBeEnabled();
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();
    expect(screen.queryByText(PRIVATE_SPACE)).not.toBeInTheDocument();

    await userEvent.click(directorySwitch());
    expect(directorySwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('is enabled for a request-to-join space as well', () => {
    seed({ visibility: 'request' }, true);
    render(<DiscoveryPanel spaceId="space-1" />);
    expect(directorySwitch()).toBeEnabled();
  });

  it('forces the switch off when the draft visibility goes private', async () => {
    seed({ visibility: 'public', directoryListed: true }, true);
    render(<DiscoveryPanel spaceId="space-1" />);
    expect(directorySwitch()).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: /Private/ }));

    expect(directorySwitch()).toHaveAttribute('aria-checked', 'false');
    expect(directorySwitch()).toBeDisabled();
    expect(screen.getByText(PRIVATE_SPACE)).toBeInTheDocument();
  });

  it('sends directoryListed with the save through the store', async () => {
    seed({ visibility: 'public', description: 'Design chatter' }, true);
    const updateSpace = mockUpdateSpace();
    render(<DiscoveryPanel spaceId="space-1" />);

    await userEvent.click(directorySwitch());
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateSpace).toHaveBeenCalledWith('space-1', {
      visibility: 'public',
      description: 'Design chatter',
      directoryListed: true,
    });
  });

  it('never saves a remote space through the home client', async () => {
    seed({ visibility: 'public', description: 'Remote chatter', _instanceOrigin: 'https://remote.test' }, true);
    const updateSpace = mockUpdateSpace();
    const homeUpdate = vi.spyOn(api.spaces, 'update').mockResolvedValue({ ...space, directoryListed: true });
    render(<DiscoveryPanel spaceId="space-1" />);

    await userEvent.click(directorySwitch());
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateSpace).toHaveBeenCalledWith('space-1', {
      visibility: 'public',
      description: 'Remote chatter',
      directoryListed: true,
    });
    expect(homeUpdate).not.toHaveBeenCalled();
  });

  it('carries the disclosure sentence', () => {
    seed({ visibility: 'public' }, true);
    render(<DiscoveryPanel spaceId="space-1" />);
    expect(screen.getByText(/Listing makes public: the space's name, description, icon, banner, member count and this instance's address\./)).toBeInTheDocument();
  });
});
