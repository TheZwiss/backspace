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

/** The settings document the hint reads, with the two flags under test on top. */
function limits(flags: { discoveryEnabled: boolean; directoryEnabled: boolean }): InstanceStreamingLimits {
  return {
    maxBitrateKbps: 20000,
    minBitrateKbps: 500,
    bitrateStepKbps: 500,
    allowedResolutions: [540, 720, 1080],
    allowedFramerates: [30, 45, 60],
    maxResolution: 1080,
    maxFramerate: 60,
    bitrateMatrixOverrides: null,
    allowCustomBitrate: true,
    ...flags,
  };
}

const DISCOVERY_OFF = limits({ discoveryEnabled: false, directoryEnabled: false });
const NOT_LISTED = limits({ discoveryEnabled: true, directoryEnabled: false });
const LISTED = limits({ discoveryEnabled: true, directoryEnabled: true });

const updateInstanceSettings = vi.fn(async (_data: Partial<InstanceAdminSettings>) => {});
const onDiscoveryEnabled = vi.fn();

/**
 * Seeds the settings store the hint reads. The explore store is seeded with
 * the opposite of the settings document by default: nothing but
 * `exploreStore.fetchSpaces` writes that field, so a hint that read it would
 * be reporting a fact its own buttons cannot change, and these tests would
 * pass while the row never moved.
 */
function seed(state: { isAdmin: boolean; streamingLimits: InstanceStreamingLimits | null }) {
  useExploreStore.setState({
    discoveryEnabled: state.streamingLimits === null ? true : !state.streamingLimits.discoveryEnabled,
  });
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
  it('renders nothing while the instance settings have not arrived', () => {
    seed({ isAdmin: true, streamingLimits: null });
    const { container } = render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing to a member either before the settings arrive: unknown is not a fact', () => {
    seed({ isAdmin: false, streamingLimits: null });
    const { container } = render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when discovery is on and the instance is listed', () => {
    seed({ isAdmin: true, streamingLimits: LISTED });
    const { container } = render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a member on an instance with discovery on that is not listed', () => {
    seed({ isAdmin: false, streamingLimits: NOT_LISTED });
    const { container } = render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  /*
   * "List them" writes `directoryEnabled`, which only does anything on an
   * instance the operator gave a DIRECTORY_ENDPOINT. Without one the click
   * wrote the flag, the row vanished as though it had worked, and no hub was
   * ever told. The row is the one that offers the write, so it is the one
   * withheld.
   */
  it('does not offer to list spaces on an instance with no directory endpoint', () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    const { container } = render(
      <InstanceDiscoveryHint directoryConfigured={false} onDiscoveryEnabled={onDiscoveryEnabled} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not offer it before the endpoint is known either: unknown is not a fact', () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    const { container } = render(
      <InstanceDiscoveryHint directoryConfigured={null} onDiscoveryEnabled={onDiscoveryEnabled} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  /*
   * Space discovery is local and needs no hub, so its row is unaffected by
   * the endpoint: an admin with discovery off still gets told, and still gets
   * the switch.
   */
  it('still names discovery being off with no directory endpoint', () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    render(<InstanceDiscoveryHint directoryConfigured={false} onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(screen.getByText(/Space discovery is off on this instance/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on space discovery' })).toBeInTheDocument();
  });

  it('tells a member why Explore is empty, without an action', () => {
    seed({ isAdmin: false, streamingLimits: DISCOVERY_OFF });
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    expect(screen.getByText(MEMBER_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the reason to an admin and offers the switch', () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeInTheDocument();
    expect(screen.queryByText(NOT_LISTED_TEXT)).not.toBeInTheDocument();
  });

  it('follows the settings document, not the explore store, in both directions', () => {
    // Discovery on in the explore store, off in the document the button writes.
    useExploreStore.setState({ discoveryEnabled: true });
    useSettingsStore.setState({ isAdmin: true, streamingLimits: DISCOVERY_OFF, updateInstanceSettings });
    const { unmount } = render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeInTheDocument();
    unmount();

    // And the other way round: the stale explore store must not suppress the row.
    useExploreStore.setState({ discoveryEnabled: false });
    useSettingsStore.setState({ streamingLimits: NOT_LISTED });
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);
    expect(screen.getByRole('button', { name: LIST_LABEL })).toBeInTheDocument();
  });

  it('enabling discovery saves the flag, refetches the page and moves the hint to the listing rung', async () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    // Exactly what the real store does on a resolved PATCH: the server's answer
    // mirrored into `streamingLimits`, and nothing else touched.
    updateInstanceSettings.mockImplementationOnce(async () => {
      useSettingsStore.setState({ streamingLimits: NOT_LISTED });
    });
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));

    expect(updateInstanceSettings).toHaveBeenCalledWith({ discoveryEnabled: true });
    await waitFor(() => expect(onDiscoveryEnabled).toHaveBeenCalledOnce());

    // Row 3 to row 4 on the settings alone, with no refetch having landed: the
    // second rung is offered in the same place the first was.
    expect(screen.queryByText(ADMIN_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LIST_LABEL })).toBeInTheDocument();
  });

  it('the enable button is disabled while its call is in flight', async () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    let finish: () => void = () => {};
    updateInstanceSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));
    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeDisabled();
    expect(onDiscoveryEnabled).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeEnabled());
  });

  it('a rejected enable shows the described error and leaves the row in place', async () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    const err = new HttpError(403, 'Forbidden', undefined, 'forbidden');
    updateInstanceSettings.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));

    await waitFor(() => expect(screen.getByText(describeError(err))).toBeInTheDocument());
    expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeEnabled();
    expect(onDiscoveryEnabled).not.toHaveBeenCalled();
  });

  it('a failure does not follow the hint to the next row', async () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    const err = new HttpError(403, 'Forbidden', undefined, 'forbidden');
    updateInstanceSettings.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));
    await waitFor(() => expect(screen.getByText(describeError(err))).toBeInTheDocument());

    // The rung is moved somewhere else, in another tab or by another admin.
    useSettingsStore.setState({ streamingLimits: NOT_LISTED });

    await waitFor(() => expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument());
    expect(screen.queryByText(describeError(err))).not.toBeInTheDocument();

    // And it is gone, not merely hidden: the rung coming back must not bring
    // a message about an attempt made before it with it.
    useSettingsStore.setState({ streamingLimits: DISCOVERY_OFF });
    await waitFor(() => expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument());
    expect(screen.queryByText(describeError(err))).not.toBeInTheDocument();
  });

  it('a failure raised after the row moved is not recorded at all', async () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    const err = new HttpError(403, 'Forbidden', undefined, 'forbidden');
    let fail: (reason: unknown) => void = () => {};
    updateInstanceSettings.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));

    // The rung moves while the request is in flight: a WS ready, another tab.
    useSettingsStore.setState({ streamingLimits: NOT_LISTED });
    await waitFor(() => expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument());

    fail(err);
    await waitFor(() => expect(screen.getByRole('button', { name: LIST_LABEL })).toBeEnabled());
    expect(screen.queryByText(describeError(err))).not.toBeInTheDocument();

    // The row the attempt was made on comes back, and it comes back clean.
    useSettingsStore.setState({ streamingLimits: DISCOVERY_OFF });
    await waitFor(() => expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument());
    expect(screen.queryByText(describeError(err))).not.toBeInTheDocument();
  });

  it('a thrown non-Error falls back to the catalog message', async () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    updateInstanceSettings.mockImplementationOnce(() => Promise.reject('nope'));
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));

    await waitFor(() => expect(screen.getByText('Could not change the setting.')).toBeInTheDocument());
  });

  it('tells an admin the instance is not listed and offers to list it', async () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    updateInstanceSettings.mockImplementationOnce(async () => {
      useSettingsStore.setState({ streamingLimits: LISTED });
    });
    const user = userEvent.setup();
    const { container } = render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

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
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    let finish: () => void = () => {};
    updateInstanceSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: LIST_LABEL }));
    expect(screen.getByRole('button', { name: LIST_LABEL })).toBeDisabled();

    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: LIST_LABEL })).toBeEnabled());
  });

  it('a rejected listing shows the described error and leaves the row in place', async () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    const err = new HttpError(400, 'Directory requires discovery', undefined, 'directory_requires_discovery');
    updateInstanceSettings.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint directoryConfigured onDiscoveryEnabled={onDiscoveryEnabled} />);

    await user.click(screen.getByRole('button', { name: LIST_LABEL }));

    await waitFor(() => expect(screen.getByText(describeError(err))).toBeInTheDocument());
    expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LIST_LABEL })).toBeEnabled();
  });
});
