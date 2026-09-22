import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceAdminSettings } from '@backspace/shared';
import { GeneralPanel } from './GeneralPanel';
import { useSettingsStore } from '../../../stores/settingsStore';

const INVITE = 'Invite only';
const LOCAL = 'Local space discovery';
const GLOBAL = 'Global space discovery';
const OPEN_ACCOUNTS = 'Open federated accounts';
const DISCLOSURE = /its name, description, icon, banner, member count and this instance's address/;

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
  directoryLastPingAt: null,
  directoryLastError: null,
};

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
  useSettingsStore.setState({ instanceSettings: null, fetchInstanceSettings: vi.fn().mockResolvedValue(undefined) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GeneralPanel discovery ladder', () => {
  it('offers the three rungs with their descriptions', () => {
    seed({});
    render(<GeneralPanel />);
    expect(rung(INVITE)).toBeInTheDocument();
    expect(rung(LOCAL)).toBeInTheDocument();
    expect(rung(GLOBAL)).toBeInTheDocument();
    expect(screen.getByText('Spaces here are listed nowhere. Invite links still work.')).toBeInTheDocument();
    expect(screen.getByText('Spaces appear in Explore for people on this instance and on instances connected to it.')).toBeInTheDocument();
    expect(screen.getByText('Spaces that opt in also appear in the public Backspace directory, on every instance.')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('checks the invite rung when discovery is off', () => {
    seed({ discoveryEnabled: false, directoryEnabled: false });
    render(<GeneralPanel />);
    expect(rung(INVITE)).toBeChecked();
    expect(rung(LOCAL)).not.toBeChecked();
    expect(rung(GLOBAL)).not.toBeChecked();
  });

  it('checks the local rung when discovery is on and the directory is off', () => {
    seed({ discoveryEnabled: true, directoryEnabled: false });
    render(<GeneralPanel />);
    expect(rung(LOCAL)).toBeChecked();
    expect(rung(INVITE)).not.toBeChecked();
    expect(rung(GLOBAL)).not.toBeChecked();
  });

  it('checks the global rung when both flags are on', () => {
    seed({ discoveryEnabled: true, directoryEnabled: true });
    render(<GeneralPanel />);
    expect(rung(GLOBAL)).toBeChecked();
    expect(rung(INVITE)).not.toBeChecked();
    expect(rung(LOCAL)).not.toBeChecked();
  });

  it('sends both flags off when the global rung drops to invite only', async () => {
    const update = seed({ discoveryEnabled: true, directoryEnabled: true });
    render(<GeneralPanel />);

    await userEvent.click(rung(INVITE));
    expect(rung(INVITE)).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ discoveryEnabled: false, directoryEnabled: false }));
  });

  it('sends both flags on when invite only climbs to the global rung', async () => {
    const update = seed({ discoveryEnabled: false, directoryEnabled: false });
    render(<GeneralPanel />);

    await userEvent.click(rung(GLOBAL));
    expect(rung(GLOBAL)).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ discoveryEnabled: true, directoryEnabled: true }));
  });

  it('keeps discovery on and drops the directory when the global rung steps down to local', async () => {
    const update = seed({ discoveryEnabled: true, directoryEnabled: true });
    render(<GeneralPanel />);

    await userEvent.click(rung(LOCAL));
    expect(rung(LOCAL)).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ discoveryEnabled: true, directoryEnabled: false }));
  });

  it('hangs the status line and the disclosure under the global rung only', async () => {
    seed({ discoveryEnabled: true, directoryEnabled: false });
    render(<GeneralPanel />);
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
    render(<GeneralPanel />);
    expect(screen.getByText(/listed spaces will show as closed to new accounts/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeInTheDocument();
  });

  it('says nothing while federated accounts are open', () => {
    seed({ directoryEnabled: true, federatedRegistrationOpen: true });
    render(<GeneralPanel />);
    expect(screen.queryByText(/closed to new accounts/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: OPEN_ACCOUNTS })).not.toBeInTheDocument();
  });

  it('says nothing on the rungs below global', () => {
    seed({ discoveryEnabled: true, directoryEnabled: false, federatedRegistrationOpen: false });
    const { unmount } = render(<GeneralPanel />);
    expect(screen.queryByText(/closed to new accounts/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: OPEN_ACCOUNTS })).not.toBeInTheDocument();
    unmount();

    seed({ discoveryEnabled: false, directoryEnabled: false, federatedRegistrationOpen: false });
    render(<GeneralPanel />);
    expect(screen.queryByText(/closed to new accounts/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: OPEN_ACCOUNTS })).not.toBeInTheDocument();
  });

  it('warns the moment the global rung is picked, before any save', async () => {
    const update = seed({ discoveryEnabled: false, directoryEnabled: false, federatedRegistrationOpen: false });
    render(<GeneralPanel />);
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
    render(<GeneralPanel />);

    const button = screen.getByRole('button', { name: OPEN_ACCOUNTS });
    await act(async () => { fireEvent.click(button); });
    expect(update).toHaveBeenCalledWith({ federatedRegistrationOpen: true });
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeDisabled();

    await act(async () => { release?.(); });
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeEnabled();
  });

  it('picking the global rung never opens federated accounts by itself', async () => {
    const update = seed({ discoveryEnabled: true, directoryEnabled: false, federatedRegistrationOpen: false });
    render(<GeneralPanel />);

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
    render(<GeneralPanel />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: OPEN_ACCOUNTS })); });
    expect(screen.getByText('nope')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OPEN_ACCOUNTS })).toBeEnabled();
  });
});

describe('GeneralPanel directory status line', () => {
  it('says the directory was never reported before the first ping', () => {
    seed({ directoryEnabled: true, directoryLastPingAt: null, directoryLastError: null });
    render(<GeneralPanel />);
    expect(screen.getByText('Never reported')).toBeInTheDocument();
    expect(screen.queryByText(/Last attempt failed/)).not.toBeInTheDocument();
  });

  it('shows the last successful ping as a date and time', () => {
    seed({ directoryEnabled: true, directoryLastPingAt: Date.UTC(2023, 10, 14, 22, 13) });
    render(<GeneralPanel />);
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
    render(<GeneralPanel />);
    expect(screen.getByText('Last attempt failed (502)')).toBeInTheDocument();
    expect(screen.getByText(/^Last reported /)).toBeInTheDocument();
  });

  it('spells out a fetch error through its reason', () => {
    seed({ directoryEnabled: true, directoryLastError: { at: 1, status: 'fetch', reason: 'unreachable' } });
    render(<GeneralPanel />);
    expect(screen.getByText('Last attempt failed (the directory could not reach this instance)')).toBeInTheDocument();
  });

  it('explains an origin refusal and what to set', () => {
    seed({ directoryEnabled: true, directoryLastError: { at: 1, status: 'origin' } });
    render(<GeneralPanel />);
    expect(screen.getByText(/Last attempt failed \(the directory refused this instance's address; it must be an https domain with no port \(set DOMAIN or PUBLIC_ORIGIN\)\)/)).toBeInTheDocument();
  });

  it('carries the disclosure sentence', () => {
    seed({ directoryEnabled: true });
    render(<GeneralPanel />);
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

    const { unmount } = render(<GeneralPanel />);
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

    render(<GeneralPanel />);
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

    render(<GeneralPanel />);
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

    render(<GeneralPanel />);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole('textbox', { name: 'Instance Name' })).toHaveValue('Renamed elsewhere');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
