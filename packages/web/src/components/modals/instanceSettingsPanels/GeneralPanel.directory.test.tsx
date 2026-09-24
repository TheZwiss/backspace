import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via the listing note's spaceStore -> chatStore ->
// useWebSocket -> voiceStore.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceAdminSettings, InstanceInfoResponse } from '@backspace/shared';
import { MemoryRouter } from 'react-router-dom';
import { GeneralPanel } from './GeneralPanel';
import { api } from '../../../api/client';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSpaceStore, type TaggedSpace } from '../../../stores/spaceStore';
import { useUIStore } from '../../../stores/uiStore';
import { PermissionBits, permissionsToString } from '../../../utils/permissions';

const INVITE = 'Invite only';
const LOCAL = 'Local space discovery';
const GLOBAL = 'Allow global listing';
const OPEN_ACCOUNTS = 'Open federated accounts';
const DISCLOSURE = /its name, description, icon, banner, member count and this instance's address/;
const BROWSE = 'Show global spaces in Explore';
const NO_ENDPOINT = 'This instance is not configured to reach a directory, so there is nothing to show.';

/** The public instance info, with the one field this panel reads set per test. */
function info(directoryConfigured: boolean): InstanceInfoResponse {
  return {
    name: 'Workbench',
    version: '1.4.0',
    registrationOpen: true,
    federatedRegistrationOpen: true,
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
    sourceCodeUrl: 'https://example.test/source',
    commit: null,
    // What this panel reads: the operator's endpoint, on its own. The other
    // two are reported beside it and no surface here uses them.
    directoryConfigured,
    directoryAvailable: directoryConfigured,
    directoryEnabled: false,
  };
}

/** Replaces the default pending answer with a real one for this test. */
function withInfo(directoryConfigured: boolean): void {
  vi.spyOn(api.instance, 'info').mockResolvedValue(info(directoryConfigured));
}

const base: InstanceAdminSettings = {
  instanceName: 'Workbench',
  registrationOpen: true,
  federatedRegistrationOpen: true,
  discoveryEnabled: true,
  maxUploadSizeMb: 100,
  federationRelayEnabled: true,
  federationRelayTtlDays: 30,
  defaultAutoRotateIntervalDays: 90,
  autoAcceptPeering: true,
  directoryEnabled: false,
  directoryBrowseEnabled: true,
  directoryLastPingAt: null,
  directoryLastError: null,
  // One space already listed, so the note that nothing is listed stays out
  // of the tests that are not about it.
  directoryListedSpaceCount: 1,
};

/** The panel as the app mounts it: inside the router its listing note navigates with. */
function renderPanel(): ReturnType<typeof render> {
  return render(<MemoryRouter><GeneralPanel /></MemoryRouter>);
}

function seed(overrides: Partial<InstanceAdminSettings>): ReturnType<typeof vi.fn> {
  const updateInstanceSettings = vi.fn().mockResolvedValue(undefined);
  useSettingsStore.setState({
    instanceSettings: { ...base, ...overrides },
    updateInstanceSettings,
  });
  return updateInstanceSettings;
}

function rung(name: string): HTMLElement {
  return screen.getByRole('radio', { name });
}

beforeEach(() => {
  // The default is "the answer has not arrived": a promise that never settles,
  // so every test that does not care about the endpoint renders the panel in
  // the state it holds before the info call returns, with no state update
  // landing outside the test's control.
  vi.spyOn(api.instance, 'info').mockReturnValue(new Promise<InstanceInfoResponse>(() => {}));
  useSettingsStore.setState({ instanceSettings: null, fetchInstanceSettings: vi.fn().mockResolvedValue(undefined) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GeneralPanel discovery ladder', () => {
  it('offers the three rungs with their descriptions', () => {
    seed({});
    renderPanel();
    expect(rung(INVITE)).toBeInTheDocument();
    expect(rung(LOCAL)).toBeInTheDocument();
    expect(rung(GLOBAL)).toBeInTheDocument();
    expect(screen.getByText('Spaces here are listed nowhere. Invite links still work.')).toBeInTheDocument();
    expect(screen.getByText('Spaces appear in Explore for people on this instance and on instances connected to it.')).toBeInTheDocument();
    expect(screen.getByText('Each space can then be manually listed in the global Backspace directory from its own Discovery settings.')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('groups the three rungs and nothing else', () => {
    seed({ discoveryEnabled: true, directoryEnabled: true, federatedRegistrationOpen: false });
    renderPanel();
    const group = screen.getByRole('radiogroup', { name: 'Space discovery' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);

    // A radiogroup may own only radios, so everything the global rung brings
    // with it sits outside the group even though it reads as being under the
    // rung.
    expect(within(group).queryByRole('button', { name: OPEN_ACCOUNTS })).not.toBeInTheDocument();
    expect(within(group).queryByText(/closed to new accounts/)).not.toBeInTheDocument();
    expect(within(group).queryByText('Never reported')).not.toBeInTheDocument();
    expect(within(group).queryByText(DISCLOSURE)).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeInTheDocument();
    expect(screen.getByText('Never reported')).toBeInTheDocument();
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
  });

  it('checks the invite rung when discovery is off', () => {
    seed({ discoveryEnabled: false, directoryEnabled: false });
    renderPanel();
    expect(rung(INVITE)).toBeChecked();
    expect(rung(LOCAL)).not.toBeChecked();
    expect(rung(GLOBAL)).not.toBeChecked();
  });

  it('checks the local rung when discovery is on and the directory is off', () => {
    seed({ discoveryEnabled: true, directoryEnabled: false });
    renderPanel();
    expect(rung(LOCAL)).toBeChecked();
    expect(rung(INVITE)).not.toBeChecked();
    expect(rung(GLOBAL)).not.toBeChecked();
  });

  it('checks the global rung when both flags are on', () => {
    seed({ discoveryEnabled: true, directoryEnabled: true });
    renderPanel();
    expect(rung(GLOBAL)).toBeChecked();
    expect(rung(INVITE)).not.toBeChecked();
    expect(rung(LOCAL)).not.toBeChecked();
  });

  it('sends both flags off when the global rung drops to invite only', async () => {
    const update = seed({ discoveryEnabled: true, directoryEnabled: true });
    renderPanel();

    await userEvent.click(rung(INVITE));
    expect(rung(INVITE)).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ discoveryEnabled: false, directoryEnabled: false }));
  });

  it('sends both flags on when invite only climbs to the global rung', async () => {
    const update = seed({ discoveryEnabled: false, directoryEnabled: false });
    renderPanel();

    await userEvent.click(rung(GLOBAL));
    expect(rung(GLOBAL)).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ discoveryEnabled: true, directoryEnabled: true }));
  });

  it('keeps discovery on and drops the directory when the global rung steps down to local', async () => {
    const update = seed({ discoveryEnabled: true, directoryEnabled: true });
    renderPanel();

    await userEvent.click(rung(LOCAL));
    expect(rung(LOCAL)).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ discoveryEnabled: true, directoryEnabled: false }));
  });

  it('hangs the status line and the disclosure under the global rung only', async () => {
    seed({ discoveryEnabled: true, directoryEnabled: false });
    renderPanel();
    expect(screen.queryByText('Never reported')).not.toBeInTheDocument();
    expect(screen.queryByText(DISCLOSURE)).not.toBeInTheDocument();

    await userEvent.click(rung(GLOBAL));
    expect(screen.getByText('Never reported')).toBeInTheDocument();
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();

    await userEvent.click(rung(INVITE));
    expect(screen.queryByText('Never reported')).not.toBeInTheDocument();
    expect(screen.queryByText(DISCLOSURE)).not.toBeInTheDocument();
  });
});

describe('GeneralPanel federated accounts warning', () => {
  it('warns under the global rung while federated accounts are closed', () => {
    seed({ directoryEnabled: true, federatedRegistrationOpen: false });
    renderPanel();
    expect(screen.getByText(/listed spaces will show as closed to new accounts/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeInTheDocument();
  });

  it('says nothing while federated accounts are open', () => {
    seed({ directoryEnabled: true, federatedRegistrationOpen: true });
    renderPanel();
    expect(screen.queryByText(/closed to new accounts/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: OPEN_ACCOUNTS })).not.toBeInTheDocument();
  });

  /*
   * The note urges a security decision to head off a consequence that cannot
   * happen on an instance with no endpoint: nothing there reaches a hub, so
   * no listed space is shown to anyone as closed to new accounts. It sat
   * directly under a rung that had just said nothing can be listed globally.
   */
  it('says nothing with no directory endpoint, under a rung that has already said so', async () => {
    withInfo(false);
    seed({ discoveryEnabled: true, directoryEnabled: true, federatedRegistrationOpen: false });
    renderPanel();
    await act(async () => {});

    expect(screen.getByText(/nothing here can be listed globally/)).toBeInTheDocument();
    expect(screen.queryByText(/closed to new accounts/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: OPEN_ACCOUNTS })).not.toBeInTheDocument();
    // The document really is built and served, so these two stay.
    expect(screen.getByText('Never reported')).toBeInTheDocument();
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
  });

  it('says it again once an endpoint is configured', async () => {
    withInfo(true);
    seed({ discoveryEnabled: true, directoryEnabled: true, federatedRegistrationOpen: false });
    renderPanel();
    await act(async () => {});

    expect(screen.getByText(/listed spaces will show as closed to new accounts/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeInTheDocument();
  });

  it('says nothing on the rungs below global', () => {
    seed({ discoveryEnabled: true, directoryEnabled: false, federatedRegistrationOpen: false });
    const { unmount } = renderPanel();
    expect(screen.queryByText(/closed to new accounts/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: OPEN_ACCOUNTS })).not.toBeInTheDocument();
    unmount();

    seed({ discoveryEnabled: false, directoryEnabled: false, federatedRegistrationOpen: false });
    renderPanel();
    expect(screen.queryByText(/closed to new accounts/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: OPEN_ACCOUNTS })).not.toBeInTheDocument();
  });

  it('warns the moment the global rung is picked, before any save', async () => {
    const update = seed({ discoveryEnabled: false, directoryEnabled: false, federatedRegistrationOpen: false });
    renderPanel();
    expect(screen.queryByText(/closed to new accounts/)).not.toBeInTheDocument();

    await userEvent.click(rung(GLOBAL));

    expect(screen.getByText(/listed spaces will show as closed to new accounts/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('opens federated accounts on its own, and disables the button while the call is in flight', async () => {
    let release: (() => void) | null = null;
    const update = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    useSettingsStore.setState({
      instanceSettings: { ...base, directoryEnabled: true, federatedRegistrationOpen: false },
      updateInstanceSettings: update,
    });
    renderPanel();

    const button = screen.getByRole('button', { name: OPEN_ACCOUNTS });
    await act(async () => { fireEvent.click(button); });
    expect(update).toHaveBeenCalledWith({ federatedRegistrationOpen: true });
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeDisabled();

    await act(async () => { release?.(); });
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeEnabled();
  });

  it('picking the global rung never opens federated accounts by itself', async () => {
    const update = seed({ discoveryEnabled: true, directoryEnabled: false, federatedRegistrationOpen: false });
    renderPanel();

    await userEvent.click(rung(GLOBAL));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.not.objectContaining({ federatedRegistrationOpen: true }));
  });

  it('shows a failure to open federated accounts through the panel error line', async () => {
    const update = vi.fn().mockRejectedValue(new Error('nope'));
    useSettingsStore.setState({
      instanceSettings: { ...base, directoryEnabled: true, federatedRegistrationOpen: false },
      updateInstanceSettings: update,
    });
    renderPanel();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: OPEN_ACCOUNTS })); });
    expect(screen.getByText('nope')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeEnabled();
  });
});

describe('GeneralPanel directory status line', () => {
  it('says the directory was never reported before the first ping', () => {
    seed({ directoryEnabled: true, directoryLastPingAt: null, directoryLastError: null });
    renderPanel();
    expect(screen.getByText('Never reported')).toBeInTheDocument();
    expect(screen.queryByText(/Last attempt failed/)).not.toBeInTheDocument();
  });

  it('shows the last successful ping as a date and time', () => {
    seed({ directoryEnabled: true, directoryLastPingAt: Date.UTC(2023, 10, 14, 22, 13) });
    renderPanel();
    const line = screen.getByText(/^Last reported /);
    expect(line).toHaveTextContent(/2023/);
    expect(screen.queryByText('Never reported')).not.toBeInTheDocument();
  });

  it('shows a numeric last error with its status', () => {
    seed({
      directoryEnabled: true,
      directoryLastPingAt: Date.UTC(2023, 10, 14, 22, 13),
      directoryLastError: { at: Date.UTC(2023, 10, 15, 22, 13), status: 502 },
    });
    renderPanel();
    expect(screen.getByText('Last attempt failed (502)')).toBeInTheDocument();
    expect(screen.getByText(/^Last reported /)).toBeInTheDocument();
  });

  it('spells out a fetch error through its reason', () => {
    seed({ directoryEnabled: true, directoryLastError: { at: 1, status: 'fetch', reason: 'unreachable' } });
    renderPanel();
    expect(screen.getByText('Last attempt failed (the directory could not reach this instance)')).toBeInTheDocument();
  });

  it('explains an origin refusal and what to set', () => {
    seed({ directoryEnabled: true, directoryLastError: { at: 1, status: 'origin' } });
    renderPanel();
    expect(screen.getByText(/Last attempt failed \(the directory refused this instance's address; it must be an https domain with no port \(set DOMAIN or PUBLIC_ORIGIN\)\)/)).toBeInTheDocument();
  });

  it('carries the disclosure sentence', () => {
    seed({ directoryEnabled: true });
    renderPanel();
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
  });
});

describe('GeneralPanel directory status refresh', () => {
  it('refetches the settings every 10 seconds while mounted and follows the new ping time', async () => {
    vi.useFakeTimers();
    seed({ directoryEnabled: true, directoryLastPingAt: null });
    const fetchInstanceSettings = vi.fn(async () => {
      useSettingsStore.setState((state) => ({
        instanceSettings: { ...state.instanceSettings!, directoryLastPingAt: Date.UTC(2023, 10, 14, 22, 13) },
      }));
    });
    useSettingsStore.setState({ fetchInstanceSettings });

    const { unmount } = renderPanel();
    expect(screen.getByText('Never reported')).toBeInTheDocument();
    expect(fetchInstanceSettings).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(fetchInstanceSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Last reported /)).toHaveTextContent(/2023/);
    expect(screen.queryByText('Never reported')).not.toBeInTheDocument();

    unmount();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(fetchInstanceSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps an unsaved edit across a background refresh', async () => {
    vi.useFakeTimers();
    seed({ instanceName: 'Workbench', discoveryEnabled: true, directoryEnabled: false, directoryLastPingAt: null });
    const fetchInstanceSettings = vi.fn(async () => {
      useSettingsStore.setState((state) => ({
        instanceSettings: { ...state.instanceSettings!, directoryLastPingAt: 1_700_000_000_000 },
      }));
    });
    useSettingsStore.setState({ fetchInstanceSettings });

    renderPanel();
    const name = screen.getByRole('textbox', { name: 'Instance Name' });
    await act(async () => { fireEvent.change(name, { target: { value: 'Renamed' } }); });
    await act(async () => { fireEvent.click(rung(GLOBAL)); });
    expect(name).toHaveValue('Renamed');
    expect(rung(GLOBAL)).toBeChecked();

    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(fetchInstanceSettings).toHaveBeenCalledTimes(1);
    expect(name).toHaveValue('Renamed');
    expect(rung(GLOBAL)).toBeChecked();
    expect(screen.getByText(/^Last reported /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('follows the server again once an edit has arrived there through another writer', async () => {
    vi.useFakeTimers();
    seed({ instanceName: 'Workbench' });
    const answers = ['Workbench 2', 'Workbench 3'];
    const fetchInstanceSettings = vi.fn(async () => {
      const instanceName = answers.shift();
      if (instanceName === undefined) return;
      useSettingsStore.setState((state) => ({
        instanceSettings: { ...state.instanceSettings!, instanceName },
      }));
    });
    useSettingsStore.setState({ fetchInstanceSettings });

    renderPanel();
    const name = screen.getByRole('textbox', { name: 'Instance Name' });
    await act(async () => { fireEvent.change(name, { target: { value: 'Workbench 2' } }); });
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

    // A second admin saved the same name: nothing left to save.
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(name).toHaveValue('Workbench 2');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    // That admin renamed again: the untouched draft follows, with no stale save offered.
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(name).toHaveValue('Workbench 3');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('reseeds an untouched draft from a refresh that changed the editable fields', async () => {
    vi.useFakeTimers();
    seed({ instanceName: 'Workbench' });
    const fetchInstanceSettings = vi.fn(async () => {
      useSettingsStore.setState((state) => ({
        instanceSettings: { ...state.instanceSettings!, instanceName: 'Renamed elsewhere' },
      }));
    });
    useSettingsStore.setState({ fetchInstanceSettings });

    renderPanel();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole('textbox', { name: 'Instance Name' })).toHaveValue('Renamed elsewhere');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

describe('GeneralPanel global browsing toggle', () => {
  it('renders under the ladder with its label and description', () => {
    seed({});
    renderPanel();
    expect(screen.getByRole('switch', { name: BROWSE })).toBeInTheDocument();
    expect(screen.getByText(/People here see spaces from other instances in Outer Space/)).toBeInTheDocument();
  });

  it('is outside the discovery radiogroup, which owns only its rungs', () => {
    seed({});
    renderPanel();
    const group = screen.getByRole('radiogroup', { name: 'Space discovery' });
    expect(within(group).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('reflects the loaded value', () => {
    seed({ directoryBrowseEnabled: true });
    const { unmount } = renderPanel();
    expect(screen.getByRole('switch', { name: BROWSE })).toBeChecked();
    unmount();

    seed({ directoryBrowseEnabled: false });
    renderPanel();
    expect(screen.getByRole('switch', { name: BROWSE })).not.toBeChecked();
  });

  it('is a draft field: nothing is written until the panel is saved', async () => {
    const update = seed({ directoryBrowseEnabled: true });
    renderPanel();

    await userEvent.click(screen.getByRole('switch', { name: BROWSE }));
    expect(screen.getByRole('switch', { name: BROWSE })).not.toBeChecked();
    expect(update).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ directoryBrowseEnabled: false }));
  });

  it('turns browsing back on through the same save path', async () => {
    const update = seed({ directoryBrowseEnabled: false });
    renderPanel();

    await userEvent.click(screen.getByRole('switch', { name: BROWSE }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ directoryBrowseEnabled: true }));
  });

  it('leaves the ladder alone: the rung does not move and both its flags are sent unchanged', async () => {
    const update = seed({ discoveryEnabled: true, directoryEnabled: true, directoryBrowseEnabled: true });
    renderPanel();

    await userEvent.click(screen.getByRole('switch', { name: BROWSE }));
    expect(rung(GLOBAL)).toBeChecked();
    expect(rung(LOCAL)).not.toBeChecked();
    expect(rung(INVITE)).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      discoveryEnabled: true,
      directoryEnabled: true,
      directoryBrowseEnabled: false,
    }));
  });

  it('moving the ladder leaves browsing where it was', async () => {
    const update = seed({ discoveryEnabled: true, directoryEnabled: false, directoryBrowseEnabled: false });
    renderPanel();

    await userEvent.click(rung(GLOBAL));
    expect(screen.getByRole('switch', { name: BROWSE })).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      discoveryEnabled: true,
      directoryEnabled: true,
      directoryBrowseEnabled: false,
    }));
  });

  it('says there is no directory to reach, and disables the row, when the instance has no endpoint', async () => {
    withInfo(false);
    seed({ directoryBrowseEnabled: true });
    renderPanel();

    expect(await screen.findByText(NO_ENDPOINT)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: BROWSE })).toBeDisabled();
  });

  // The stored column says browsing is on; nothing is browsed, because there
  // is nothing to browse. The switch shows what is in effect, and the column
  // is left alone so browsing resumes at the admin's choice if an endpoint
  // ever appears.
  it('shows the switch off with no endpoint, whatever the stored setting says', async () => {
    withInfo(false);
    const update = seed({ directoryBrowseEnabled: true });
    renderPanel();

    await screen.findByText(NO_ENDPOINT);
    expect(screen.getByRole('switch', { name: BROWSE })).not.toBeChecked();
    // Shown off, not written off: nothing was saved and nothing is offered.
    expect(update).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('says nothing while the instance can reach a directory', async () => {
    withInfo(true);
    seed({ directoryBrowseEnabled: true });
    renderPanel();

    await screen.findByRole('switch', { name: BROWSE });
    expect(screen.queryByText(NO_ENDPOINT)).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: BROWSE })).toBeEnabled();
  });

  /*
   * The endpoint fact is reported on its own, so the browse setting no longer
   * has anything to do with reading it. It used to: `directoryAvailable`
   * folded the two together, and the panel had to pair the answer with the
   * setting and refuse the pairing whenever the setting moved. All of that is
   * gone, and with it the case where an endpoint-less instance could not be
   * recognised at all while browsing was off.
   */
  it('says there is no directory to reach even while browsing is off', async () => {
    withInfo(false);
    seed({ directoryBrowseEnabled: false });
    renderPanel();

    expect(await screen.findByText(NO_ENDPOINT)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: BROWSE })).toBeDisabled();
    expect(screen.getByRole('switch', { name: BROWSE })).not.toBeChecked();
  });

  it('says nothing when the instance info cannot be read', async () => {
    vi.spyOn(api.instance, 'info').mockRejectedValue(new Error('offline'));
    seed({ directoryBrowseEnabled: true });
    renderPanel();
    await act(async () => {});

    expect(screen.queryByText(NO_ENDPOINT)).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: BROWSE })).toBeEnabled();
    expect(screen.getByRole('switch', { name: BROWSE })).toBeChecked();
  });

  /*
   * One fact, one read. Nothing this panel does can create or remove an
   * endpoint, so nothing re-asks: not a save, and not the 10 second settings
   * poll, which hands the store a fresh settings object every time it lands.
   * Widening the effect's dependencies would turn a single read into a
   * request every ten seconds against the public info endpoint.
   */
  it('reads the endpoint once, and neither a save nor the poll asks again', async () => {
    vi.useFakeTimers();
    const infoSpy = vi.spyOn(api.instance, 'info').mockResolvedValue(info(true));
    const fetchInstanceSettings = vi.fn(async () => {
      useSettingsStore.setState((state) => (
        state.instanceSettings === null ? {} : { instanceSettings: { ...state.instanceSettings } }
      ));
    });
    const update = vi.fn(async (data: Partial<InstanceAdminSettings>) => {
      useSettingsStore.setState((state) => ({
        instanceSettings: { ...state.instanceSettings!, ...data },
      }));
    });
    useSettingsStore.setState({
      instanceSettings: { ...base, directoryBrowseEnabled: true },
      updateInstanceSettings: update,
      fetchInstanceSettings,
    });

    renderPanel();
    await act(async () => {});
    expect(infoSpy).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: BROWSE })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ directoryBrowseEnabled: false }));

    await act(async () => { vi.advanceTimersByTime(30_000); });
    // The poll really ran, so the assertion under it is about the read and
    // not about a timer that never fired.
    expect(fetchInstanceSettings).toHaveBeenCalledTimes(3);
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});

describe('GeneralPanel discovery ladder without a directory endpoint', () => {
  /*
   * The rung promised that listed spaces "appear in the public Backspace
   * directory, on every instance". With no DIRECTORY_ENDPOINT the pinger
   * never starts and no hub is ever told, so the promise was false and the
   * rung offered a level that did nothing.
   */
  it('does not offer the global rung and replaces its promise with the reason', async () => {
    withInfo(false);
    seed({ discoveryEnabled: true, directoryEnabled: false });
    renderPanel();
    await act(async () => {});

    expect(rung(GLOBAL)).toBeDisabled();
    expect(screen.getByText(/nothing here can be listed globally/)).toBeInTheDocument();
    expect(screen.queryByText('Each space can then be manually listed in the global Backspace directory from its own Discovery settings.')).not.toBeInTheDocument();
    // The rungs that still do something stay available.
    expect(rung(INVITE)).toBeEnabled();
    expect(rung(LOCAL)).toBeEnabled();
  });

  /*
   * A first open of the settings modal. The panel mounts before its parent's
   * `fetchInstanceSettings()` has landed, so `instanceSettings` is null for
   * the first render and the answer arrives afterwards. The endpoint read no
   * longer depends on the settings at all, so it goes out at once and the row
   * is right as soon as both have arrived, in either order.
   */
  it('answers on a first open, with the settings arriving after the endpoint read', async () => {
    const infoSpy = vi.spyOn(api.instance, 'info').mockResolvedValue(info(false));
    useSettingsStore.setState({ instanceSettings: null, updateInstanceSettings: vi.fn() });

    const { rerender } = renderPanel();
    await act(async () => {});
    expect(infoSpy).toHaveBeenCalledTimes(1);

    act(() => {
      useSettingsStore.setState({ instanceSettings: { ...base, directoryBrowseEnabled: true } });
    });
    rerender(<MemoryRouter><GeneralPanel /></MemoryRouter>);

    expect(screen.getByText(NO_ENDPOINT)).toBeInTheDocument();
    expect(rung(GLOBAL)).toBeDisabled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('offers the global rung and its description once an endpoint is configured', async () => {
    withInfo(true);
    seed({ discoveryEnabled: true, directoryEnabled: false });
    renderPanel();
    await act(async () => {});

    expect(rung(GLOBAL)).toBeEnabled();
    expect(screen.getByText('Each space can then be manually listed in the global Backspace directory from its own Discovery settings.')).toBeInTheDocument();
    expect(screen.queryByText(/nothing here can be listed globally/)).not.toBeInTheDocument();
  });

  /*
   * A rung already stored as selected still reads as selected, unlike the
   * browse switch, which renders off. A radio shows what the draft will save,
   * and a different rung rendered as checked would make the ladder disagree
   * with its own write. Stepping down from it stays possible.
   */
  it('leaves an already-selected global rung checked, and lets the admin step down', async () => {
    withInfo(false);
    const update = seed({ discoveryEnabled: true, directoryEnabled: true });
    renderPanel();
    await act(async () => {});

    expect(rung(GLOBAL)).toBeChecked();
    expect(rung(GLOBAL)).toBeDisabled();

    await act(async () => { fireEvent.click(rung(LOCAL)); });
    expect(rung(LOCAL)).toBeChecked();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ discoveryEnabled: true, directoryEnabled: false }));
  });
});

describe('GeneralPanel listing note', () => {
  const NOTE = 'Turning this on does not list any spaces by itself. Each space still has to switch on "List in the global Backspace directory" in its Discovery settings.';
  const SHOW = 'Show me where';
  const SAVE_AND_SHOW = 'Save and show me where';
  const MANAGE = permissionsToString(PermissionBits.MANAGE_SPACE);

  function space(id: string, overrides: Partial<TaggedSpace> = {}): TaggedSpace {
    return {
      id,
      name: id,
      icon: null,
      banner: null,
      avatarColor: null,
      ownerId: 'admin-1',
      inviteCode: null,
      visibility: 'public',
      directoryListed: false,
      description: null,
      createdAt: 1,
      _instanceOrigin: '',
      ...overrides,
    };
  }

  function seedSpaces(spaces: TaggedSpace[], managed: string[]): void {
    useSpaceStore.setState({
      spaces,
      spaceLayout: null,
      folders: [],
      currentSpaceId: null,
      spacePermissions: new Map(managed.map((id) => [id, MANAGE])),
    });
  }

  beforeEach(() => {
    seedSpaces([], []);
    useUIStore.setState({ activeModal: 'userSettings', modalData: { tab: 'instance' }, isMobile: false, showDms: true });
  });

  it('says listing is per space while the global rung is stored and nothing is listed', () => {
    seedSpaces([space('a')], ['a']);
    seed({ discoveryEnabled: true, directoryEnabled: true, directoryListedSpaceCount: 0 });
    renderPanel();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SHOW })).toBeInTheDocument();
  });

  it('is absent under the lower rungs', () => {
    seedSpaces([space('a')], ['a']);
    seed({ discoveryEnabled: true, directoryEnabled: false, directoryListedSpaceCount: 0 });
    renderPanel();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it('gives way to the count once a space is listed', () => {
    seedSpaces([space('a')], ['a']);
    seed({ discoveryEnabled: true, directoryEnabled: true, directoryListedSpaceCount: 3 });
    renderPanel();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    expect(screen.getByText('3 spaces listed')).toBeInTheDocument();
  });

  it('shows no count while nothing is listed', () => {
    seed({ discoveryEnabled: true, directoryEnabled: true, directoryListedSpaceCount: 0 });
    renderPanel();
    expect(screen.queryByText(/spaces? listed$/)).not.toBeInTheDocument();
  });

  it('appears as soon as the rung is picked, offering to save before leaving', () => {
    seedSpaces([space('a')], ['a']);
    seed({ discoveryEnabled: true, directoryEnabled: false, directoryListedSpaceCount: 0 });
    renderPanel();
    fireEvent.click(rung(GLOBAL));
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    // Leaving plainly would drop the unsaved pick.
    expect(screen.queryByRole('button', { name: SHOW })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: SAVE_AND_SHOW })).toBeInTheDocument();
  });

  it('saves the draft, then opens the space', async () => {
    seedSpaces([space('a')], ['a']);
    const update = seed({ discoveryEnabled: true, directoryEnabled: false, directoryListedSpaceCount: 0 });
    renderPanel();
    fireEvent.click(rung(GLOBAL));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SAVE_AND_SHOW })); });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ discoveryEnabled: true, directoryEnabled: true }));
    expect(useSpaceStore.getState().currentSpaceId).toBe('a');
    expect(useUIStore.getState().activeModal).toBe('spaceSettings');
    expect(useUIStore.getState().modalData).toEqual({ tab: 'discovery' });
  });

  it('stays on the panel when the save fails', async () => {
    seedSpaces([space('a')], ['a']);
    const update = seed({ discoveryEnabled: true, directoryEnabled: false, directoryListedSpaceCount: 0 });
    update.mockRejectedValueOnce(new Error('boom'));
    renderPanel();
    fireEvent.click(rung(GLOBAL));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SAVE_AND_SHOW })); });
    expect(update).toHaveBeenCalledTimes(1);
    expect(useSpaceStore.getState().currentSpaceId).toBeNull();
    expect(useUIStore.getState().activeModal).toBe('userSettings');
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('is not shown on an instance with no directory endpoint', async () => {
    withInfo(false);
    seedSpaces([space('a')], ['a']);
    seed({ discoveryEnabled: true, directoryEnabled: true, directoryListedSpaceCount: 0 });
    renderPanel();
    await act(async () => {});
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it('offers no button when the admin manages no space hosted here', () => {
    seedSpaces(
      [space('unmanaged'), space('remote', { _instanceOrigin: 'https://peer.test' })],
      ['remote'],
    );
    seed({ discoveryEnabled: true, directoryEnabled: true, directoryListedSpaceCount: 0 });
    renderPanel();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SHOW })).not.toBeInTheDocument();
  });

  it('opens the Discovery tab of the chosen space and makes it the current space', () => {
    seedSpaces([space('private-one', { visibility: 'private' }), space('public-one')], ['private-one', 'public-one']);
    seed({ discoveryEnabled: true, directoryEnabled: true, directoryListedSpaceCount: 0 });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: SHOW }));
    expect(useSpaceStore.getState().currentSpaceId).toBe('public-one');
    expect(useUIStore.getState().activeModal).toBe('spaceSettings');
    expect(useUIStore.getState().modalData).toEqual({ tab: 'discovery' });
    expect(useUIStore.getState().showDms).toBe(false);
  });
});
