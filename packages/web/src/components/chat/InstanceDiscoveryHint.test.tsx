import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceAdminSettings, InstanceStreamingLimits } from '@backspace/shared';
import { HttpError } from '../../api/client';
import { InstanceDiscoveryHint } from './InstanceDiscoveryHint';
import { useExploreStore } from '../../stores/exploreStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { describeError } from '../../i18n/errors';

// Stub AudioManager: the explore store imports the instance store transitively
// and jsdom has no AudioWorkletNode.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

const MEMBER_TEXT = 'Your instance administrator has turned off space discovery. Spaces here are joinable by invite link only.';
const ADMIN_TEXT = 'Space discovery is off on this instance. Spaces here are joinable by invite link only.';
const ENABLE_LABEL = 'Turn on space discovery';
const NOT_LISTED_TEXT = 'Spaces on this instance are not listed in the public directory.';
const LIST_LABEL = 'List them';

function limits(directoryEnabled: boolean, discoveryEnabled = true): InstanceStreamingLimits {
  return {
    maxBitrateKbps: 20000,
    minBitrateKbps: 500,
    bitrateStepKbps: 500,
    allowedResolutions: [540, 720, 1080],
    allowedFramerates: [30, 45, 60],
    maxResolution: 1080,
    maxFramerate: 60,
    discoveryEnabled,
    directoryEnabled,
    bitrateMatrixOverrides: null,
    allowCustomBitrate: true,
  };
}

const updateInstanceSettings = vi.fn(async (_data: Partial<InstanceAdminSettings>) => {});
const onDiscoveryEnabled = vi.fn();

/** Seeds the two stores the hint reads. */
function seed(state: { discoveryEnabled: boolean; isAdmin: boolean; streamingLimits: InstanceStreamingLimits | null }) {
  useExploreStore.setState({ discoveryEnabled: state.discoveryEnabled });
  useSettingsStore.setState({
    isAdmin: state.isAdmin,
    streamingLimits: state.streamingLimits,
    updateInstanceSettings,
  });
}

beforeEach(() => {
  updateInstanceSettings.mockReset();
  updateInstanceSettings.mockResolvedValue(undefined);
  onDiscoveryEnabled.mockReset();
});

describe('InstanceDiscoveryHint', () => {
  it('renders nothing while the instance settings have not arrived and discovery is on', () => {
    seed({ discoveryEnabled: true, isAdmin: true, streamingLimits: null });
    const { container } = render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when discovery is on and the instance is listed', () => {
    seed({ discoveryEnabled: true, isAdmin: true, streamingLimits: limits(true) });
    const { container } = render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a member on an instance with discovery on that is not listed', () => {
    seed({ discoveryEnabled: true, isAdmin: false, streamingLimits: limits(false) });
    const { container } = render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('tells a member why Explore is empty, without an action', () => {
    seed({ discoveryEnabled: false, isAdmin: false, streamingLimits: limits(false, false) });
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    expect(screen.getByText(MEMBER_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('gives a member no action even before the instance settings arrive', () => {
    seed({ discoveryEnabled: false, isAdmin: false, streamingLimits: null });
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    expect(screen.getByText(MEMBER_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the reason to an admin and offers the switch', () => {
    seed({ discoveryEnabled: false, isAdmin: true, streamingLimits: limits(false, false) });
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeInTheDocument();
    expect(screen.queryByText(NOT_LISTED_TEXT)).not.toBeInTheDocument();
  });

  it('the admin row appears before the instance settings arrive, since it does not need them', () => {
    seed({ discoveryEnabled: false, isAdmin: true, streamingLimits: null });
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeInTheDocument();
  });

  it('enabling discovery saves the flag, refetches the page and moves the hint to the listing rung', async () => {
    seed({ discoveryEnabled: false, isAdmin: true, streamingLimits: limits(false, false) });
    // The real store mirrors the server's answer back into both stores.
    updateInstanceSettings.mockImplementationOnce(async () => {
      useSettingsStore.setState({ streamingLimits: limits(false, true) });
      useExploreStore.setState({ discoveryEnabled: true });
    });
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));

    expect(updateInstanceSettings).toHaveBeenCalledWith({ discoveryEnabled: true });
    await waitFor(() => expect(onDiscoveryEnabled).toHaveBeenCalledOnce());

    // Row 3 to row 4, from the settings alone: the second rung is offered in
    // the same place the first was.
    expect(screen.queryByText(ADMIN_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LIST_LABEL })).toBeInTheDocument();
  });

  it('the enable button is disabled while its call is in flight', async () => {
    seed({ discoveryEnabled: false, isAdmin: true, streamingLimits: limits(false, false) });
    let finish: () => void = () => {};
    updateInstanceSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));
    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeDisabled();
    expect(onDiscoveryEnabled).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeEnabled());
  });

  it('a rejected enable shows the described error and leaves the row in place', async () => {
    seed({ discoveryEnabled: false, isAdmin: true, streamingLimits: limits(false, false) });
    const err = new HttpError(403, 'Forbidden', undefined, 'forbidden');
    updateInstanceSettings.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));

    await waitFor(() => expect(screen.getByText(describeError(err))).toBeInTheDocument());
    expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeEnabled();
    expect(onDiscoveryEnabled).not.toHaveBeenCalled();
  });

  it('a thrown non-Error falls back to the catalog message', async () => {
    seed({ discoveryEnabled: false, isAdmin: true, streamingLimits: limits(false, false) });
    updateInstanceSettings.mockImplementationOnce(() => Promise.reject('nope'));
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));

    await waitFor(() => expect(screen.getByText('Could not change the setting.')).toBeInTheDocument());
  });

  it('tells an admin the instance is not listed and offers to list it', async () => {
    seed({ discoveryEnabled: true, isAdmin: true, streamingLimits: limits(false) });
    updateInstanceSettings.mockImplementationOnce(async () => {
      useSettingsStore.setState({ streamingLimits: limits(true) });
    });
    const user = userEvent.setup();
    const { container } = render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();
    // Informational, not a warning: no amber treatment on this row.
    expect(container.querySelector('.bg-accent-amber\\/10')).toBeNull();

    await user.click(screen.getByRole('button', { name: LIST_LABEL }));

    expect(updateInstanceSettings).toHaveBeenCalledWith({ directoryEnabled: true });
    // Listing changes nothing about what this instance sees, so nothing refetches.
    expect(onDiscoveryEnabled).not.toHaveBeenCalled();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('the list button is disabled while its call is in flight', async () => {
    seed({ discoveryEnabled: true, isAdmin: true, streamingLimits: limits(false) });
    let finish: () => void = () => {};
    updateInstanceSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: LIST_LABEL }));
    expect(screen.getByRole('button', { name: LIST_LABEL })).toBeDisabled();

    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: LIST_LABEL })).toBeEnabled());
  });

  it('a rejected listing shows the described error and leaves the row in place', async () => {
    seed({ discoveryEnabled: true, isAdmin: true, streamingLimits: limits(false) });
    const err = new HttpError(400, 'Directory requires discovery', undefined, 'directory_requires_discovery');
    updateInstanceSettings.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: LIST_LABEL }));

    await waitFor(() => expect(screen.getByText(describeError(err))).toBeInTheDocument());
    expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LIST_LABEL })).toBeEnabled();
  });
});
