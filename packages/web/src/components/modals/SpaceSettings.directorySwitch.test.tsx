import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
import { api, HttpError, type BackspaceApiClient } from '../../api/client';
import { describeError } from '../../i18n/errors';

const SWITCH = 'List in the Backspace directory';
const ADMIN_OFF = 'Your instance administrator has to turn on global space discovery.';
// The same fact in the administrator's own voice, with the way out of it.
const ADMIN_OFF_SELF = 'Global space discovery is off on this instance.';
const RUNG_ACTION = 'Turn it on';
const RUNG_INTRO = 'This turns on the global rung for the whole instance: spaces here become discoverable in Explore, and the instance starts reporting itself to the public directory.';
const CONFIRM_TITLE = 'List spaces from this instance publicly?';
const CONFIRM_LABEL = 'List spaces';
const CONFIRM_DISCLOSURE = "For each listed space this makes public: its name, description, icon, banner, member count and this instance's address. People browsing the directory load the icon and banner from this instance.";
const CONFIRM_OPT_IN = 'Only spaces whose owners turn listing on are sent, so this switch lists no space on its own.';
const CONFIRM_OFF = 'To stop listing later: Settings, Instance, General, the space discovery choice.';
const PRIVATE_SPACE = 'Set visibility to public or request to join first.';
const LOAD_FAILED = 'Could not load the settings.';
const NOT_CONFIGURED = 'This instance is not configured to reach a directory, so listing this space would reach none.';

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

/**
 * `isAdmin` is seeded explicitly rather than left at whatever a previous test
 * put there: it now decides which of two sentences the panel states, so a
 * leaked `true` would quietly rewrite the expectations of every case below.
 */
function seed(spaceOverrides: Partial<TaggedSpace>, directoryEnabled: boolean, isAdmin = false): void {
  useSpaceStore.setState({ spaces: [{ ...space, ...spaceOverrides }] });
  useSettingsStore.setState({ streamingLimits: { ...limits, directoryEnabled }, isAdmin });
}

const realUpdateInstanceSettings = useSettingsStore.getState().updateInstanceSettings;

/** Stands in for the instance-wide write the reason's action makes. */
function mockUpdateInstanceSettings(): ReturnType<typeof vi.fn> {
  const updateInstanceSettings = vi.fn().mockResolvedValue(undefined);
  useSettingsStore.setState({ updateInstanceSettings });
  return updateInstanceSettings;
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
/** A connected remote whose client answers with whatever `getStreaming` does. */
function remoteInstance(origin: string, getStreaming: () => Promise<InstanceStreamingLimits>): ConnectedInstance {
  return {
    origin,
    label: new URL(origin).host,
    token: 'tok',
    user: { id: 'remote-user', username: 'jannis@home.test', displayName: 'Jannis' } as ConnectedInstance['user'],
    username: 'jannis@home.test',
    status: 'connected',
    api: { settings: { getStreaming } } as unknown as BackspaceApiClient,
  };
}

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
  useSettingsStore.setState({ updateInstanceSettings: realUpdateInstanceSettings, isAdmin: false });
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

  it('is disabled with the endpoint reason on an instance with no directory to reach', () => {
    // The admin's opt-in can be stored on an instance that has no
    // DIRECTORY_ENDPOINT: the server gates its public listing document on the
    // two discovery flags alone, so the document is served and simply no hub
    // fetches it. The switch used to be enabled here and its write reached
    // nothing.
    useSpaceStore.setState({ spaces: [{ ...space, visibility: 'public' }] });
    useSettingsStore.setState({ streamingLimits: { ...limits, directoryEnabled: true, directoryConfigured: false } });

    render(<DiscoveryPanel spaceId="space-1" />);

    expect(directorySwitch()).toBeDisabled();
    expect(screen.getByText(NOT_CONFIGURED)).toBeInTheDocument();
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();
  });

  it('says the endpoint is missing before it says the administrator has to act', () => {
    // Both are off. The endpoint is the one the administrator cannot fix by
    // flipping the setting the other reason points at.
    useSpaceStore.setState({ spaces: [{ ...space, visibility: 'public' }] });
    useSettingsStore.setState({ streamingLimits: { ...limits, directoryEnabled: false, directoryConfigured: false } });

    render(<DiscoveryPanel spaceId="space-1" />);

    expect(screen.getByText(NOT_CONFIGURED)).toBeInTheDocument();
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();
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

  it('takes the endpoint fact from the space\'s own instance, not from home', async () => {
    // The trap a home-only `GET /instance/info` read would fall into: home
    // has a directory to reach, the instance the space lives on does not.
    seed({ visibility: 'public', _instanceOrigin: 'https://remote.test' }, true);
    connectRemote('https://remote.test', Promise.resolve({
      ...limits, discoveryEnabled: true, directoryEnabled: true, directoryConfigured: false,
    }));

    render(<DiscoveryPanel spaceId="space-1" />);

    await waitFor(() => expect(screen.getByText(NOT_CONFIGURED)).toBeInTheDocument());
    expect(directorySwitch()).toBeDisabled();
  });

  it('a late answer for the origin left behind writes nothing', async () => {
    // The panel is not remounted when the space changes: `spaceId` comes from
    // the store and the modal resets on `isOpen` alone, so browser back or
    // forward swaps the origin under a request already in flight. A late
    // write used to land as another origin's answer, which reads as "not
    // answered yet": a disabled switch with no reason and no Retry, and no
    // further load to correct it.
    let answerFirst: (limits: InstanceStreamingLimits) => void = () => {};
    const first = vi.fn(() => new Promise<InstanceStreamingLimits>((resolve) => { answerFirst = resolve; }));
    const second = vi.fn(async () => ({ ...limits, discoveryEnabled: true, directoryEnabled: true, directoryConfigured: true }));

    useSpaceStore.setState({ spaces: [
      { ...space, id: 'space-1', visibility: 'public', _instanceOrigin: 'https://first.test' },
      { ...space, id: 'space-2', visibility: 'public', _instanceOrigin: 'https://second.test' },
    ] });
    useInstanceStore.setState({ instances: [
      remoteInstance('https://first.test', first),
      remoteInstance('https://second.test', second),
    ] });

    const { rerender } = render(<DiscoveryPanel spaceId="space-1" />);
    expect(first).toHaveBeenCalledTimes(1);

    // The space changes under the open modal; the second origin answers.
    rerender(<DiscoveryPanel spaceId="space-2" />);
    await waitFor(() => expect(directorySwitch()).toBeEnabled());

    // The first origin answers late, for a space nobody is looking at.
    answerFirst({ ...limits, discoveryEnabled: false, directoryEnabled: false, directoryConfigured: false });
    await act(async () => { await Promise.resolve(); });

    expect(directorySwitch()).toBeEnabled();
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();
    expect(screen.queryByText(NOT_CONFIGURED)).not.toBeInTheDocument();
    expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
  });

  it('reads a home space\'s flags from the store without a request', () => {
    seed({ visibility: 'public', _instanceOrigin: '' }, true);
    const homeStreaming = vi.spyOn(api.settings, 'getStreaming');

    render(<DiscoveryPanel spaceId="space-1" />);
    expect(directorySwitch()).toBeEnabled();
    expect(homeStreaming).not.toHaveBeenCalled();
  });
});

/*
 * The panel used to end the conversation for the one person who could change
 * the thing it named: "your instance administrator has to turn on global
 * space discovery", read by the instance administrator, with nowhere to go.
 *
 * Admin rights are per instance, and the client only knows its own. The
 * home WS `ready` is the only thing that ever writes `settingsStore.isAdmin`,
 * a remote `ready` carrying the same field is discarded, and no other signal
 * exists. So the action is offered for a space that lives here and for
 * nobody else, and the write goes to the only instance the client can speak
 * to as an admin.
 */
describe('DiscoveryPanel global rung action', () => {
  it('names the setting rather than an absent administrator when the reader is one', () => {
    seed({ visibility: 'public' }, false, true);
    render(<DiscoveryPanel spaceId="space-1" />);

    expect(screen.getByText(ADMIN_OFF_SELF)).toBeInTheDocument();
    expect(screen.queryByText(ADMIN_OFF)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: RUNG_ACTION })).toBeInTheDocument();
    // The space switch is still locked: the rung has to land first.
    expect(directorySwitch()).toBeDisabled();
  });

  it('leaves the sentence alone for an owner who is not an instance admin', () => {
    seed({ visibility: 'public' }, false, false);
    render(<DiscoveryPanel spaceId="space-1" />);

    expect(screen.getByText(ADMIN_OFF)).toBeInTheDocument();
    expect(screen.queryByText(ADMIN_OFF_SELF)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RUNG_ACTION })).not.toBeInTheDocument();
  });

  /*
   * The trap. Being an admin at home says nothing about rights on the
   * instance that owns a remote space, and the write this action makes goes
   * to home whatever space is on screen. Offering it here would show a button
   * that either does nothing for this space or changes the wrong instance.
   */
  it('offers nothing on a remote space, whatever the reader is at home', async () => {
    seed({ visibility: 'public', _instanceOrigin: 'https://remote.test' }, true, true);
    const getStreaming = connectRemote(
      'https://remote.test',
      Promise.resolve({ ...limits, discoveryEnabled: true, directoryEnabled: false, directoryConfigured: true }),
    );
    const updateInstanceSettings = mockUpdateInstanceSettings();
    render(<DiscoveryPanel spaceId="space-1" />);

    await waitFor(() => expect(screen.getByText(ADMIN_OFF)).toBeInTheDocument());
    expect(getStreaming).toHaveBeenCalled();
    expect(screen.queryByText(ADMIN_OFF_SELF)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RUNG_ACTION })).not.toBeInTheDocument();
    expect(updateInstanceSettings).not.toHaveBeenCalled();
  });

  it('says nothing about the rung when the instance has no directory endpoint', () => {
    useSpaceStore.setState({ spaces: [{ ...space, visibility: 'public' }] });
    useSettingsStore.setState({
      streamingLimits: { ...limits, directoryEnabled: false, directoryConfigured: false },
      isAdmin: true,
    });
    render(<DiscoveryPanel spaceId="space-1" />);

    expect(screen.getByText(NOT_CONFIGURED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RUNG_ACTION })).not.toBeInTheDocument();
  });

  it('explains what becomes public instead of writing it', async () => {
    seed({ visibility: 'public' }, false, true);
    const updateInstanceSettings = mockUpdateInstanceSettings();
    const user = userEvent.setup();
    render(<DiscoveryPanel spaceId="space-1" />);

    await user.click(screen.getByRole('button', { name: RUNG_ACTION }));

    expect(updateInstanceSettings).not.toHaveBeenCalled();
    expect(screen.getByText(CONFIRM_TITLE)).toBeInTheDocument();
    // The one line this surface adds, because its write is the whole rung
    // rather than the listing flag alone.
    expect(screen.getByText(RUNG_INTRO)).toBeInTheDocument();
    // And the same three paragraphs the Explore hint states, from the same
    // keys: one decision, one wording.
    expect(screen.getByText(CONFIRM_DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(CONFIRM_OPT_IN)).toBeInTheDocument();
    expect(screen.getByText(CONFIRM_OFF)).toBeInTheDocument();
  });

  it('cancelling writes nothing and leaves the reason where it was', async () => {
    seed({ visibility: 'public' }, false, true);
    const updateInstanceSettings = mockUpdateInstanceSettings();
    const user = userEvent.setup();
    render(<DiscoveryPanel spaceId="space-1" />);

    await user.click(screen.getByRole('button', { name: RUNG_ACTION }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(updateInstanceSettings).not.toHaveBeenCalled();
    expect(screen.queryByText(CONFIRM_TITLE)).not.toBeInTheDocument();
    expect(screen.getByText(ADMIN_OFF_SELF)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: RUNG_ACTION })).toBeEnabled();
    expect(directorySwitch()).toBeDisabled();
  });

  /*
   * Both flags, not just the listing one. `directoryEnabled` without
   * `discoveryEnabled` is the pair the server refuses, and "global space
   * discovery" is the ladder rung that is exactly this pair.
   */
  it('confirming writes the whole global rung exactly once, and the switch unlocks', async () => {
    seed({ visibility: 'public' }, false, true);
    const updateInstanceSettings = vi.fn().mockImplementation(async () => {
      useSettingsStore.setState({
        streamingLimits: { ...limits, discoveryEnabled: true, directoryEnabled: true },
      });
    });
    useSettingsStore.setState({ updateInstanceSettings });
    const user = userEvent.setup();
    render(<DiscoveryPanel spaceId="space-1" />);

    await user.click(screen.getByRole('button', { name: RUNG_ACTION }));
    await user.click(screen.getByRole('button', { name: CONFIRM_LABEL }));

    expect(updateInstanceSettings).toHaveBeenCalledOnce();
    expect(updateInstanceSettings).toHaveBeenCalledWith({ discoveryEnabled: true, directoryEnabled: true });

    // The store mirrors the answer into the document this panel reads, so the
    // reason clears and the space switch unlocks with nothing to refetch.
    await waitFor(() => expect(directorySwitch()).toBeEnabled());
    expect(screen.queryByText(ADMIN_OFF_SELF)).not.toBeInTheDocument();
    expect(screen.queryByText(CONFIRM_TITLE)).not.toBeInTheDocument();
  });

  it('a refused rung is reported under the reason, which stays', async () => {
    seed({ visibility: 'public' }, false, true);
    const err = new HttpError(403, 'Forbidden', undefined, 'forbidden');
    const updateInstanceSettings = vi.fn().mockRejectedValue(err);
    useSettingsStore.setState({ updateInstanceSettings });
    const user = userEvent.setup();
    render(<DiscoveryPanel spaceId="space-1" />);

    await user.click(screen.getByRole('button', { name: RUNG_ACTION }));
    await user.click(screen.getByRole('button', { name: CONFIRM_LABEL }));

    // Stated under the reason, not behind a dialog that would have to be
    // dismissed to read it.
    await waitFor(() => expect(screen.getByText(describeError(err))).toBeInTheDocument());
    expect(screen.queryByText(CONFIRM_TITLE)).not.toBeInTheDocument();
    expect(screen.getByText(ADMIN_OFF_SELF)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: RUNG_ACTION })).toBeEnabled();
    expect(directorySwitch()).toBeDisabled();
  });
});
