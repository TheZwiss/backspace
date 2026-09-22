import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import { useInstanceStore, type ConnectedInstance } from '../../stores/instanceStore';
import { api, type BackspaceApiClient } from '../../api/client';

const SWITCH = 'List in the Backspace directory';
const ADMIN_OFF = 'Your instance administrator has to turn on global space discovery.';
const PRIVATE_SPACE = 'Set visibility to public or request to join first.';
const LOAD_FAILED = 'Could not load the settings.';

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

/**
 * A connected remote whose client answers `GET /settings/streaming` with the
 * given flags; the panel must read a remote space's flags through it, never
 * through the home store.
 */
function connectRemote(origin: string, answer: Promise<InstanceStreamingLimits>): ReturnType<typeof vi.fn> {
  const getStreaming = vi.fn(() => answer);
  const instance: ConnectedInstance = {
    origin,
    label: new URL(origin).host,
    token: 'tok',
    user: { id: 'remote-user', username: 'jannis@home.test', displayName: 'Jannis' } as ConnectedInstance['user'],
    username: 'jannis@home.test',
    status: 'connected',
    api: { settings: { getStreaming } } as unknown as BackspaceApiClient,
  };
  useInstanceStore.setState({ instances: [instance] });
  return getStreaming;
}

beforeEach(() => {
  vi.spyOn(api.explore, 'getJoinRequests').mockResolvedValue({ requests: [] });
  useInstanceStore.setState({ instances: [] });
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

  it('carries both disclosure sentences', () => {
    seed({ visibility: 'public' }, true);
    render(<DiscoveryPanel spaceId="space-1" />);
    expect(screen.getByText(
      "Listing makes public: the space's name, description, icon, banner, member count and this instance's address. "
      + 'People browsing the directory load the icon and banner from this instance.',
    )).toBeInTheDocument();
  });
});

describe('DiscoveryPanel instance flags by origin', () => {
  it('reads a remote space\'s flags from that instance, keeping the switch disabled until they arrive', async () => {
    seed({ visibility: 'public', _instanceOrigin: 'https://remote.test' }, false);
    const homeStreaming = vi.spyOn(api.settings, 'getStreaming');
    let answer: (limits: InstanceStreamingLimits) => void = () => {};
    const getStreaming = connectRemote('https://remote.test', new Promise((resolve) => { answer = resolve; }));

    render(<DiscoveryPanel spaceId="space-1" />);
    expect(getStreaming).toHaveBeenCalledTimes(1);
    expect(directorySwitch()).toBeDisabled();
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();

    answer({ ...limits, discoveryEnabled: true, directoryEnabled: true });
    await waitFor(() => expect(directorySwitch()).toBeEnabled());
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();
    expect(homeStreaming).not.toHaveBeenCalled();
  });

  it('shows the remote instance\'s reasons, not home\'s, when the remote has the directory off', async () => {
    seed({ visibility: 'public', _instanceOrigin: 'https://remote.test' }, true);
    connectRemote('https://remote.test', Promise.resolve({ ...limits, discoveryEnabled: false, directoryEnabled: false }));

    render(<DiscoveryPanel spaceId="space-1" />);
    await waitFor(() => expect(screen.getByText(ADMIN_OFF)).toBeInTheDocument());
    expect(directorySwitch()).toBeDisabled();
    expect(screen.getByText(/Space discovery is disabled/)).toBeInTheDocument();
  });

  it('falls back to the store when the remote fetch fails', async () => {
    seed({ visibility: 'public', _instanceOrigin: 'https://remote.test' }, true);
    connectRemote('https://remote.test', Promise.reject(new Error('down')));

    render(<DiscoveryPanel spaceId="space-1" />);
    await waitFor(() => expect(directorySwitch()).toBeEnabled());
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();
  });

  it('states nothing about a home instance while its settings document is still coming', async () => {
    // `fetchStreamingLimits` leaves the field null when the request fails, so
    // null is "not known", not "directory off". Defaulting it locked the
    // switch under a sentence about the administrator's setting that nobody
    // had read.
    useSpaceStore.setState({ spaces: [{ ...space, visibility: 'public' }] });
    useSettingsStore.setState({ streamingLimits: null });
    const homeStreaming = vi.spyOn(api.settings, 'getStreaming').mockReturnValue(new Promise(() => {}));

    render(<DiscoveryPanel spaceId="space-1" />);

    expect(directorySwitch()).toBeDisabled();
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();
    expect(screen.queryByText(PRIVATE_SPACE)).not.toBeInTheDocument();
    expect(screen.queryByText(/Space discovery is disabled/)).not.toBeInTheDocument();
    // Nothing failed yet, so there is nothing to retry either.
    expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
    expect(homeStreaming).toHaveBeenCalledTimes(1);
  });

  it('says its piece as soon as the document does arrive', async () => {
    useSpaceStore.setState({ spaces: [{ ...space, visibility: 'public' }] });
    useSettingsStore.setState({ streamingLimits: null });
    vi.spyOn(api.settings, 'getStreaming').mockResolvedValue({ ...limits, directoryEnabled: false });

    render(<DiscoveryPanel spaceId="space-1" />);
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(ADMIN_OFF)).toBeInTheDocument());
    expect(directorySwitch()).toBeDisabled();
  });

  it('fetches the document itself when the session never got one', async () => {
    // One WS ready fills `streamingLimits` for the whole session and nothing
    // else does for a member, so a ready whose fetch failed used to leave
    // this panel locked and silent until the next sign-in.
    useSpaceStore.setState({ spaces: [{ ...space, visibility: 'public' }] });
    useSettingsStore.setState({ streamingLimits: null });
    const homeStreaming = vi.spyOn(api.settings, 'getStreaming').mockResolvedValue({ ...limits, directoryEnabled: true });

    render(<DiscoveryPanel spaceId="space-1" />);

    await waitFor(() => expect(directorySwitch()).toBeEnabled());
    expect(homeStreaming).toHaveBeenCalledTimes(1);
  });

  it('says so when that load comes back empty, and offers the way to ask again', async () => {
    useSpaceStore.setState({ spaces: [{ ...space, visibility: 'public' }] });
    useSettingsStore.setState({ streamingLimits: null });
    const homeStreaming = vi.spyOn(api.settings, 'getStreaming').mockRejectedValueOnce(new Error('down'));

    render(<DiscoveryPanel spaceId="space-1" />);

    // The failure is what the switch is locked on, so it is said under it,
    // and it never turns into a sentence about the administrator's setting.
    expect(await screen.findByText(LOAD_FAILED)).toBeInTheDocument();
    expect(directorySwitch()).toBeDisabled();
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();

    homeStreaming.mockResolvedValueOnce({ ...limits, directoryEnabled: true });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(directorySwitch()).toBeEnabled());
    expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
    expect(homeStreaming).toHaveBeenCalledTimes(2);
  });

  it('a retry that fails again leaves the line and the button where they were', async () => {
    useSpaceStore.setState({ spaces: [{ ...space, visibility: 'public' }] });
    useSettingsStore.setState({ streamingLimits: null });
    const homeStreaming = vi.spyOn(api.settings, 'getStreaming').mockRejectedValue(new Error('down'));

    render(<DiscoveryPanel spaceId="space-1" />);
    expect(await screen.findByText(LOAD_FAILED)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(homeStreaming).toHaveBeenCalledTimes(2));
    expect(screen.getByText(LOAD_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(directorySwitch()).toBeDisabled();
  });

  it('a remote instance that answers nothing, with no home document to fall back on, says so too', async () => {
    seed({ visibility: 'public', _instanceOrigin: 'https://remote.test' }, true);
    useSettingsStore.setState({ streamingLimits: null });
    const getStreaming = connectRemote('https://remote.test', Promise.reject(new Error('down')));

    render(<DiscoveryPanel spaceId="space-1" />);

    expect(await screen.findByText(LOAD_FAILED)).toBeInTheDocument();
    expect(directorySwitch()).toBeDisabled();
    expect(getStreaming).toHaveBeenCalledTimes(1);
  });

  it('reads a home space\'s flags from the store without a request', () => {
    seed({ visibility: 'public', _instanceOrigin: '' }, true);
    const homeStreaming = vi.spyOn(api.settings, 'getStreaming');

    render(<DiscoveryPanel spaceId="space-1" />);
    expect(directorySwitch()).toBeEnabled();
    expect(homeStreaming).not.toHaveBeenCalled();
  });
});
