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
// The page's shared reader of GET /api/instance/info. Stubbed so the test can
// see whether a save tells it to reread; the real module is covered by its own test.
const { invalidateHomeInstanceInfo } = vi.hoisted(() => ({ invalidateHomeInstanceInfo: vi.fn() }));
vi.mock('../../../hooks/useHomeInstanceInfo', () => ({
  invalidateHomeInstanceInfo,
  useHomeInstanceInfo: () => null,
}));
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceAdminSettings, InstanceInfoResponse } from '@backspace/shared';
import { MemoryRouter } from 'react-router-dom';
import { GeneralPanel } from './GeneralPanel';
import { api } from '../../../api/client';
import { useSettingsStore } from '../../../stores/settingsStore';

const SUPPORT = 'Show the Support card';
const SUPPORT_DESCRIPTION = "Shows a card on the Backspace page that links to the project's Ko-fi page. Turning it off hides only that card.";

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
  directoryListedSpaceCount: 1,
  supportCardEnabled: true,
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

function supportSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: SUPPORT });
}

beforeEach(() => {
  // The info call never settles: nothing about the Support card depends on
  // it, and no state update lands outside the test's control.
  vi.spyOn(api.instance, 'info').mockReturnValue(new Promise<InstanceInfoResponse>(() => {}));
  useSettingsStore.setState({ instanceSettings: null, fetchInstanceSettings: vi.fn().mockResolvedValue(undefined) });
  invalidateHomeInstanceInfo.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GeneralPanel Support card switch', () => {
  it('renders with its label and description', () => {
    seed({});
    renderPanel();
    expect(supportSwitch()).toBeInTheDocument();
    expect(screen.getByText(SUPPORT_DESCRIPTION)).toBeInTheDocument();
  });

  it('is outside the discovery radiogroup', () => {
    seed({});
    renderPanel();
    const group = screen.getByRole('radiogroup', { name: 'Space discovery' });
    expect(within(group).queryByRole('switch', { name: SUPPORT })).not.toBeInTheDocument();
  });

  it('reflects the loaded value', () => {
    seed({ supportCardEnabled: true });
    const { unmount } = renderPanel();
    expect(supportSwitch()).toBeChecked();
    unmount();

    seed({ supportCardEnabled: false });
    renderPanel();
    expect(supportSwitch()).not.toBeChecked();
  });

  it('is a draft field: a toggle is sent in the PATCH body on save, not before', async () => {
    const update = seed({ supportCardEnabled: true });
    renderPanel();

    await userEvent.click(supportSwitch());
    expect(supportSwitch()).not.toBeChecked();
    expect(update).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ supportCardEnabled: false }));
  });

  it('turns the card back on through the same save path', async () => {
    const update = seed({ supportCardEnabled: false });
    renderPanel();

    await userEvent.click(supportSwitch());
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ supportCardEnabled: true }));
  });

  it('offers no save bar until the switch moves, and none after it moves back', async () => {
    seed({ supportCardEnabled: true });
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    await userEvent.click(supportSwitch());
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

    await userEvent.click(supportSwitch());
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('leaves the other draft fields as loaded when only it changes', async () => {
    const update = seed({ supportCardEnabled: true, discoveryEnabled: true, directoryEnabled: false, directoryBrowseEnabled: false });
    renderPanel();

    await userEvent.click(supportSwitch());
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith({
      instanceName: 'Workbench',
      discoveryEnabled: true,
      directoryEnabled: false,
      directoryBrowseEnabled: false,
      supportCardEnabled: false,
    });
  });
});

describe('GeneralPanel save and the Backspace page', () => {
  it('tells the shared instance info reader to reread after a successful save', async () => {
    const update = seed({ supportCardEnabled: true });
    renderPanel();

    await userEvent.click(supportSwitch());
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(update).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(invalidateHomeInstanceInfo).toHaveBeenCalledTimes(1));
  });

  it('leaves the reader alone when the save fails', async () => {
    const update = seed({ supportCardEnabled: true });
    update.mockRejectedValue(new Error('server said no'));
    renderPanel();

    await userEvent.click(supportSwitch());
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(update).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(invalidateHomeInstanceInfo).not.toHaveBeenCalled();
  });
});
