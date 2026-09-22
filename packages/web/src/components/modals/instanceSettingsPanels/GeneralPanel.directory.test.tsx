import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceAdminSettings } from '@backspace/shared';
import { GeneralPanel } from './GeneralPanel';
import { useSettingsStore } from '../../../stores/settingsStore';

const DIRECTORY_SWITCH = 'List spaces in the Backspace directory';
const DISCOVERY_SWITCH = 'Space Discovery';

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

function directorySwitch(): HTMLElement {
  return screen.getByRole('switch', { name: DIRECTORY_SWITCH });
}

beforeEach(() => {
  useSettingsStore.setState({ instanceSettings: null });
});

describe('GeneralPanel directory toggle', () => {
  it('is disabled with the reason while discovery is off', () => {
    seed({ discoveryEnabled: false, directoryEnabled: false });
    render(<GeneralPanel />);
    expect(directorySwitch()).toBeDisabled();
    expect(directorySwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Turn on space discovery first.')).toBeInTheDocument();
  });

  it('turning discovery off in the draft turns the directory off in the draft', async () => {
    seed({ discoveryEnabled: true, directoryEnabled: true });
    render(<GeneralPanel />);
    expect(directorySwitch()).toHaveAttribute('aria-checked', 'true');
    expect(directorySwitch()).toBeEnabled();

    await userEvent.click(screen.getByRole('switch', { name: DISCOVERY_SWITCH }));

    expect(directorySwitch()).toHaveAttribute('aria-checked', 'false');
    expect(directorySwitch()).toBeDisabled();
    expect(screen.getByText('Turn on space discovery first.')).toBeInTheDocument();
  });

  it('is enabled with no reason while discovery is on, and the save carries it', async () => {
    const update = seed({ discoveryEnabled: true, directoryEnabled: false });
    render(<GeneralPanel />);
    expect(directorySwitch()).toBeEnabled();
    expect(screen.queryByText('Turn on space discovery first.')).not.toBeInTheDocument();

    await userEvent.click(directorySwitch());
    expect(directorySwitch()).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ discoveryEnabled: true, directoryEnabled: true }));
  });

  it('notes closed federated registration in amber, and says nothing while it is open', () => {
    seed({ federatedRegistrationOpen: false });
    const { unmount } = render(<GeneralPanel />);
    expect(screen.getByText(/listed spaces will show as closed to new accounts/)).toBeInTheDocument();
    unmount();

    seed({ federatedRegistrationOpen: true });
    render(<GeneralPanel />);
    expect(screen.queryByText(/closed to new accounts/)).not.toBeInTheDocument();
  });

  it('says the directory was never reported before the first ping', () => {
    seed({ directoryLastPingAt: null, directoryLastError: null });
    render(<GeneralPanel />);
    expect(screen.getByText('Never reported')).toBeInTheDocument();
    expect(screen.queryByText(/Last attempt failed/)).not.toBeInTheDocument();
  });

  it('shows the last successful ping as a date and time', () => {
    seed({ directoryLastPingAt: Date.UTC(2023, 10, 14, 22, 13) });
    render(<GeneralPanel />);
    const line = screen.getByText(/^Last reported /);
    expect(line).toHaveTextContent(/2023/);
    expect(screen.queryByText('Never reported')).not.toBeInTheDocument();
  });

  it('shows a numeric last error with its status', () => {
    seed({
      directoryLastPingAt: Date.UTC(2023, 10, 14, 22, 13),
      directoryLastError: { at: Date.UTC(2023, 10, 15, 22, 13), status: 502 },
    });
    render(<GeneralPanel />);
    expect(screen.getByText('Last attempt failed (502)')).toBeInTheDocument();
    expect(screen.getByText(/^Last reported /)).toBeInTheDocument();
  });

  it('spells out a fetch error through its reason', () => {
    seed({ directoryLastError: { at: 1, status: 'fetch', reason: 'unreachable' } });
    render(<GeneralPanel />);
    expect(screen.getByText('Last attempt failed (the directory could not reach this instance)')).toBeInTheDocument();
  });

  it('explains an origin refusal and what to set', () => {
    seed({ directoryLastError: { at: 1, status: 'origin' } });
    render(<GeneralPanel />);
    expect(screen.getByText(/Last attempt failed \(the directory refused this instance's address; it must be an https domain with no port \(set DOMAIN or PUBLIC_ORIGIN\)\)/)).toBeInTheDocument();
  });

  it('carries the disclosure sentence', () => {
    seed({});
    render(<GeneralPanel />);
    expect(screen.getByText(/its name, description, icon, banner, member count and this instance's address/)).toBeInTheDocument();
  });
});
