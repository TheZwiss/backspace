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
const BROWSE_OFF_TEXT = 'Spaces from other instances are not shown on this instance.';
const BROWSE_LABEL = 'Show global spaces in Explore';

// The confirmations. Both labels are prefixes of nothing else on screen, and
// `getByRole`'s name option matches the whole accessible name, so the browse
// confirm button is never confused with the row button that opens it.
const LIST_CONFIRM_TITLE = 'List spaces from this instance publicly?';
const LIST_CONFIRM_LABEL = 'List spaces';
const BROWSE_CONFIRM_TITLE = 'Show spaces from other instances here?';
const BROWSE_CONFIRM_LABEL = 'Show global spaces';
const CANCEL_LABEL = 'Cancel';

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
    // The hint reads neither this nor the endpoint behind it; it is here so
    // the fixture is the document the server actually sends.
    directoryConfigured: true,
    ...flags,
  };
}

const DISCOVERY_OFF = limits({ discoveryEnabled: false, directoryEnabled: false });
const NOT_LISTED = limits({ discoveryEnabled: true, directoryEnabled: false });
const LISTED = limits({ discoveryEnabled: true, directoryEnabled: true });

const updateInstanceSettings = vi.fn(async (_data: Partial<InstanceAdminSettings>) => {});
const onDiscoveryEnabled = vi.fn();
// The page's re-read of the public instance info. It never rejects, because a
// re-read that fails is not the save's failure; the default resolves without
// moving the prop, which is the shape of a re-read that answered the same
// thing the page already had.
const onBrowseEnabled = vi.fn(async () => {});

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
  onBrowseEnabled.mockReset();
  onBrowseEnabled.mockResolvedValue(undefined);
});

/**
 * The full gesture behind a confirmed action: the row's button, then the
 * dialog's. Every test that used to be one click is now two, and writing it
 * out once keeps what each test is actually about in view.
 */
async function clickThrough(
  user: ReturnType<typeof userEvent.setup>,
  rowLabel: string,
  confirmLabel: string,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: rowLabel }));
  await user.click(screen.getByRole('button', { name: confirmLabel }));
}

describe('InstanceDiscoveryHint', () => {
  it('renders nothing while the instance settings have not arrived', () => {
    seed({ isAdmin: true, streamingLimits: null });
    const { container } = render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing to a member either before the settings arrive: unknown is not a fact', () => {
    seed({ isAdmin: false, streamingLimits: null });
    const { container } = render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when discovery is on and the instance is listed', () => {
    seed({ isAdmin: true, streamingLimits: LISTED });
    const { container } = render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a member on an instance with discovery on that is not listed', () => {
    seed({ isAdmin: false, streamingLimits: NOT_LISTED });
    const { container } = render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);
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
      <InstanceDiscoveryHint directoryConfigured={false} directoryAvailable={false} onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not offer it before the endpoint is known either: unknown is not a fact', () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    const { container } = render(
      <InstanceDiscoveryHint directoryConfigured={null} directoryAvailable={null} onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />,
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
    render(<InstanceDiscoveryHint directoryConfigured={false} directoryAvailable={false} onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);
    expect(screen.getByText(/Space discovery is off on this instance/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on space discovery' })).toBeInTheDocument();
  });

  it('tells a member why Explore is empty, without an action', () => {
    seed({ isAdmin: false, streamingLimits: DISCOVERY_OFF });
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

    expect(screen.getByText(MEMBER_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the reason to an admin and offers the switch', () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

    expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeInTheDocument();
    expect(screen.queryByText(NOT_LISTED_TEXT)).not.toBeInTheDocument();
  });

  it('follows the settings document, not the explore store, in both directions', () => {
    // Discovery on in the explore store, off in the document the button writes.
    useExploreStore.setState({ discoveryEnabled: true });
    useSettingsStore.setState({ isAdmin: true, streamingLimits: DISCOVERY_OFF, updateInstanceSettings });
    const { unmount } = render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);
    expect(screen.getByRole('button', { name: ENABLE_LABEL })).toBeInTheDocument();
    unmount();

    // And the other way round: the stale explore store must not suppress the row.
    useExploreStore.setState({ discoveryEnabled: false });
    useSettingsStore.setState({ streamingLimits: NOT_LISTED });
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);
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
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

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
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

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
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

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
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

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
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

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
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

    await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));

    await waitFor(() => expect(screen.getByText('Could not change the setting.')).toBeInTheDocument());
  });

  it('tells an admin the instance is not listed and offers to list it', async () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    updateInstanceSettings.mockImplementationOnce(async () => {
      useSettingsStore.setState({ streamingLimits: LISTED });
    });
    const user = userEvent.setup();
    const { container } = render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

    expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();
    // Informational, not a warning: no amber treatment on this row.
    expect(container.querySelector('.bg-accent-amber\\/10')).toBeNull();

    await clickThrough(user, LIST_LABEL, LIST_CONFIRM_LABEL);

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
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

    await clickThrough(user, LIST_LABEL, LIST_CONFIRM_LABEL);
    expect(screen.getByRole('button', { name: LIST_LABEL })).toBeDisabled();

    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: LIST_LABEL })).toBeEnabled());
  });

  it('a rejected listing shows the described error and leaves the row in place', async () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    const err = new HttpError(400, 'Directory requires discovery', undefined, 'directory_requires_discovery');
    updateInstanceSettings.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

    await clickThrough(user, LIST_LABEL, LIST_CONFIRM_LABEL);

    await waitFor(() => expect(screen.getByText(describeError(err))).toBeInTheDocument());
    // The refusal is stated under the row, not behind a dialog that would
    // have to be dismissed to read it.
    expect(screen.queryByText(LIST_CONFIRM_TITLE)).not.toBeInTheDocument();
    expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LIST_LABEL })).toBeEnabled();
  });

  /*
   * The incoming axis, which the table did not cover until now: with "Show
   * global spaces in Explore" off, Outer Space is absent and Explore looked
   * broken rather than configured.
   *
   * That setting lives on `InstanceAdminSettings`, which only an admin may
   * read, so a member surface cannot ask for it. What both roles may read is
   * its effect: `directoryAvailable` on the public `GET /api/instance/info`,
   * which is the endpoint and the switch together. With `directoryConfigured`
   * true, an unavailable directory can only be the switch, and that pair is
   * what these two rows are derived from.
   */
  it('tells a member that spaces from other instances are not shown, without an action', () => {
    seed({ isAdmin: false, streamingLimits: NOT_LISTED });
    render(
      <InstanceDiscoveryHint
        directoryConfigured
        directoryAvailable={false}
        onDiscoveryEnabled={onDiscoveryEnabled}
        onBrowseEnabled={onBrowseEnabled}
      />,
    );

    expect(screen.getByText(BROWSE_OFF_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the same fact to an admin and offers the setting back on', () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    const { container } = render(
      <InstanceDiscoveryHint
        directoryConfigured
        directoryAvailable={false}
        onDiscoveryEnabled={onDiscoveryEnabled}
        onBrowseEnabled={onBrowseEnabled}
      />,
    );

    expect(screen.getByText(BROWSE_OFF_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: BROWSE_LABEL })).toBeInTheDocument();
    // A choice the instance made, not a warning: the same quiet treatment the
    // listing row gets, and no amber.
    expect(container.querySelector('.bg-accent-amber\\/10')).toBeNull();
  });

  /*
   * With no endpoint there is no directory to show, and the browse setting is
   * a switch over nothing: saying "not shown here" would point at a control
   * that cannot change the outcome. Nothing for either role, which is also
   * what the listing row does without an endpoint.
   */
  it('says nothing about browsing on an instance with no directory endpoint', () => {
    for (const isAdmin of [true, false]) {
      seed({ isAdmin, streamingLimits: NOT_LISTED });
      const { container, unmount } = render(
        <InstanceDiscoveryHint
          directoryConfigured={false}
          directoryAvailable={false}
          onDiscoveryEnabled={onDiscoveryEnabled}
          onBrowseEnabled={onBrowseEnabled}
        />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('says nothing about browsing before the instance info arrives: unknown is not a fact', () => {
    seed({ isAdmin: false, streamingLimits: NOT_LISTED });
    const { container } = render(
      <InstanceDiscoveryHint
        directoryConfigured
        directoryAvailable={null}
        onDiscoveryEnabled={onDiscoveryEnabled}
        onBrowseEnabled={onBrowseEnabled}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('turning browsing on saves the flag and the row goes once the page has re-read the info', async () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    const user = userEvent.setup();
    const { container, rerender } = render(
      <InstanceDiscoveryHint
        directoryConfigured
        directoryAvailable={false}
        onDiscoveryEnabled={onDiscoveryEnabled}
        onBrowseEnabled={onBrowseEnabled}
      />,
    );

    await clickThrough(user, BROWSE_LABEL, BROWSE_CONFIRM_LABEL);

    expect(updateInstanceSettings).toHaveBeenCalledWith({ directoryBrowseEnabled: true });
    await waitFor(() => expect(onBrowseEnabled).toHaveBeenCalledOnce());
    // What this instance shows does not change what it sends out, so Inner
    // Space is not refetched.
    expect(onDiscoveryEnabled).not.toHaveBeenCalled();

    // The fact lives on the instance info, not in the settings document the
    // PATCH answers with, so the row moves when the page's re-read lands and
    // not before. Nothing in the hint remembers the click.
    expect(screen.getByText(BROWSE_OFF_TEXT)).toBeInTheDocument();
    rerender(
      <InstanceDiscoveryHint
        directoryConfigured
        directoryAvailable
        onDiscoveryEnabled={onDiscoveryEnabled}
        onBrowseEnabled={onBrowseEnabled}
      />,
    );

    // And the next rung is offered in the same place, exactly as the discovery
    // row hands over to this one: these settings also list nothing.
    expect(screen.queryByText(BROWSE_OFF_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();

    // With the listing rung already taken there is nothing left to say.
    useSettingsStore.setState({ streamingLimits: LISTED });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('the browse button stays disabled until the page re-read has answered', async () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    let finish: () => void = () => {};
    onBrowseEnabled.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(
      <InstanceDiscoveryHint
        directoryConfigured
        directoryAvailable={false}
        onDiscoveryEnabled={onDiscoveryEnabled}
        onBrowseEnabled={onBrowseEnabled}
      />,
    );

    await clickThrough(user, BROWSE_LABEL, BROWSE_CONFIRM_LABEL);
    // The PATCH has answered by now; the re-read has not, and re-enabling here
    // would offer the click again under a row that is about to go.
    expect(updateInstanceSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: BROWSE_LABEL })).toBeDisabled();

    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: BROWSE_LABEL })).toBeEnabled());
  });

  it('a rejected browse change shows the described error and leaves the row in place', async () => {
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    const err = new HttpError(403, 'Forbidden', undefined, 'forbidden');
    updateInstanceSettings.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    render(
      <InstanceDiscoveryHint
        directoryConfigured
        directoryAvailable={false}
        onDiscoveryEnabled={onDiscoveryEnabled}
        onBrowseEnabled={onBrowseEnabled}
      />,
    );

    await clickThrough(user, BROWSE_LABEL, BROWSE_CONFIRM_LABEL);

    await waitFor(() => expect(screen.getByText(describeError(err))).toBeInTheDocument());
    expect(screen.queryByText(BROWSE_CONFIRM_TITLE)).not.toBeInTheDocument();
    expect(screen.getByText(BROWSE_OFF_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: BROWSE_LABEL })).toBeEnabled();
    // The save never landed, so there is nothing for the page to re-read.
    expect(onBrowseEnabled).not.toHaveBeenCalled();
  });

  /*
   * Order, both ways. Discovery off is the deeper fact: no space here is in
   * Explore for anyone, so what this instance shows is not yet the question.
   * And browsing off comes before the listing row, because an admin who
   * cannot see Outer Space is being asked about a section that is not on the
   * page.
   */
  it('names discovery being off before browsing being off', () => {
    seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
    render(
      <InstanceDiscoveryHint
        directoryConfigured
        directoryAvailable={false}
        onDiscoveryEnabled={onDiscoveryEnabled}
        onBrowseEnabled={onBrowseEnabled}
      />,
    );

    expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(BROWSE_OFF_TEXT)).not.toBeInTheDocument();
  });

  it('names browsing being off before the listing row', () => {
    // Discovery on, nothing listed and nothing browsable: both directory rows
    // apply, and the incoming one is the one on screen.
    seed({ isAdmin: true, streamingLimits: NOT_LISTED });
    render(
      <InstanceDiscoveryHint
        directoryConfigured
        directoryAvailable={false}
        onDiscoveryEnabled={onDiscoveryEnabled}
        onBrowseEnabled={onBrowseEnabled}
      />,
    );

    expect(screen.getByText(BROWSE_OFF_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(NOT_LISTED_TEXT)).not.toBeInTheDocument();
  });

  /*
   * Both directory actions are one click that changes what this instance
   * does to everyone on it, and neither is visible from the page it changes:
   * listing publishes the instance's address and every opted-in space's
   * details to a hub anyone can read, and browsing sends every user's
   * browser to instances this administrator does not control. The click that
   * used to do either of those on its own now asks first, in words that name
   * the consequence and say where the setting is undone.
   */
  describe('the confirmations in front of the two directory actions', () => {
    const DISCLOSURE = "For each listed space this makes public: its name, description, icon, banner, member count and this instance's address. People browsing the directory load the icon and banner from this instance.";
    const LIST_OPT_IN = 'Only spaces whose owners turn listing on are sent, so this switch lists no space on its own.';
    const LIST_OFF = 'To stop listing later: Settings, Instance, General, the space discovery choice.';
    const BROWSE_LOADS = "People here see spaces from other instances in Outer Space. Their browsers load those spaces' icons and banners from the instances that own them.";
    const BROWSE_EXPOSURE = "Those instances see the IP address of every browser that loads one, and this instance's administrator does not control them.";
    const BROWSE_OFF_WHERE = 'To stop showing them later: Settings, Instance, General, the switch for global spaces in Explore.';

    it('the list action explains itself instead of writing anything', async () => {
      seed({ isAdmin: true, streamingLimits: NOT_LISTED });
      const user = userEvent.setup();
      render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

      await user.click(screen.getByRole('button', { name: LIST_LABEL }));

      expect(updateInstanceSettings).not.toHaveBeenCalled();
      expect(screen.getByText(LIST_CONFIRM_TITLE)).toBeInTheDocument();
      // What becomes public, in the words the admin settings panel already
      // uses for the same switch rather than a second version of them.
      expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
      // That the switch publishes nothing by itself.
      expect(screen.getByText(LIST_OPT_IN)).toBeInTheDocument();
      // And where it is turned off again.
      expect(screen.getByText(LIST_OFF)).toBeInTheDocument();
      // The button says what it does, not "OK".
      expect(screen.getByRole('button', { name: LIST_CONFIRM_LABEL })).toBeInTheDocument();
    });

    it('cancelling the list confirmation writes nothing and leaves the row where it was', async () => {
      seed({ isAdmin: true, streamingLimits: NOT_LISTED });
      const user = userEvent.setup();
      render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

      await user.click(screen.getByRole('button', { name: LIST_LABEL }));
      await user.click(screen.getByRole('button', { name: CANCEL_LABEL }));

      expect(updateInstanceSettings).not.toHaveBeenCalled();
      expect(screen.queryByText(LIST_CONFIRM_TITLE)).not.toBeInTheDocument();
      expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: LIST_LABEL })).toBeEnabled();
    });

    it('confirming the list action writes the flag exactly once', async () => {
      seed({ isAdmin: true, streamingLimits: NOT_LISTED });
      const user = userEvent.setup();
      render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

      await clickThrough(user, LIST_LABEL, LIST_CONFIRM_LABEL);

      expect(updateInstanceSettings).toHaveBeenCalledOnce();
      expect(updateInstanceSettings).toHaveBeenCalledWith({ directoryEnabled: true });
      await waitFor(() => expect(screen.queryByText(LIST_CONFIRM_TITLE)).not.toBeInTheDocument());
    });

    it('the browse action explains itself instead of writing anything', async () => {
      seed({ isAdmin: true, streamingLimits: NOT_LISTED });
      const user = userEvent.setup();
      render(
        <InstanceDiscoveryHint
          directoryConfigured
          directoryAvailable={false}
          onDiscoveryEnabled={onDiscoveryEnabled}
          onBrowseEnabled={onBrowseEnabled}
        />,
      );

      await user.click(screen.getByRole('button', { name: BROWSE_LABEL }));

      expect(updateInstanceSettings).not.toHaveBeenCalled();
      expect(screen.getByText(BROWSE_CONFIRM_TITLE)).toBeInTheDocument();
      expect(screen.getByText(BROWSE_LOADS)).toBeInTheDocument();
      // The part the settings panel does not spell out: who learns what from
      // those requests.
      expect(screen.getByText(BROWSE_EXPOSURE)).toBeInTheDocument();
      expect(screen.getByText(BROWSE_OFF_WHERE)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: BROWSE_CONFIRM_LABEL })).toBeInTheDocument();
    });

    it('cancelling the browse confirmation writes nothing and leaves the row where it was', async () => {
      seed({ isAdmin: true, streamingLimits: NOT_LISTED });
      const user = userEvent.setup();
      render(
        <InstanceDiscoveryHint
          directoryConfigured
          directoryAvailable={false}
          onDiscoveryEnabled={onDiscoveryEnabled}
          onBrowseEnabled={onBrowseEnabled}
        />,
      );

      await user.click(screen.getByRole('button', { name: BROWSE_LABEL }));
      await user.click(screen.getByRole('button', { name: CANCEL_LABEL }));

      expect(updateInstanceSettings).not.toHaveBeenCalled();
      expect(onBrowseEnabled).not.toHaveBeenCalled();
      expect(screen.queryByText(BROWSE_CONFIRM_TITLE)).not.toBeInTheDocument();
      expect(screen.getByText(BROWSE_OFF_TEXT)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: BROWSE_LABEL })).toBeEnabled();
    });

    it('confirming the browse action writes the flag exactly once', async () => {
      seed({ isAdmin: true, streamingLimits: NOT_LISTED });
      const user = userEvent.setup();
      render(
        <InstanceDiscoveryHint
          directoryConfigured
          directoryAvailable={false}
          onDiscoveryEnabled={onDiscoveryEnabled}
          onBrowseEnabled={onBrowseEnabled}
        />,
      );

      await clickThrough(user, BROWSE_LABEL, BROWSE_CONFIRM_LABEL);

      expect(updateInstanceSettings).toHaveBeenCalledOnce();
      expect(updateInstanceSettings).toHaveBeenCalledWith({ directoryBrowseEnabled: true });
      await waitFor(() => expect(screen.queryByText(BROWSE_CONFIRM_TITLE)).not.toBeInTheDocument());
    });

    /*
     * Space discovery is local to this instance, reveals nothing outward and
     * is undone by the same control. A dialog in front of it would be noise,
     * and noise is what teaches an admin to click past the two that matter.
     */
    it('turning on space discovery is still one click, with nothing to confirm', async () => {
      seed({ isAdmin: true, streamingLimits: DISCOVERY_OFF });
      const user = userEvent.setup();
      render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

      await user.click(screen.getByRole('button', { name: ENABLE_LABEL }));

      expect(updateInstanceSettings).toHaveBeenCalledWith({ discoveryEnabled: true });
      expect(screen.queryByRole('button', { name: CANCEL_LABEL })).not.toBeInTheDocument();
    });

    /*
     * The settings can move under an open dialog, from another tab or a WS
     * ready. A dialog asking about a rung that is no longer on the page must
     * go with it rather than stay and write what the admin is no longer
     * looking at.
     */
    it('a rung that moves while its dialog is open takes the dialog with it', async () => {
      seed({ isAdmin: true, streamingLimits: NOT_LISTED });
      const user = userEvent.setup();
      render(<InstanceDiscoveryHint directoryConfigured directoryAvailable onDiscoveryEnabled={onDiscoveryEnabled} onBrowseEnabled={onBrowseEnabled} />);

      await user.click(screen.getByRole('button', { name: LIST_LABEL }));
      expect(screen.getByText(LIST_CONFIRM_TITLE)).toBeInTheDocument();

      useSettingsStore.setState({ streamingLimits: DISCOVERY_OFF });

      await waitFor(() => expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument());
      expect(screen.queryByText(LIST_CONFIRM_TITLE)).not.toBeInTheDocument();
      expect(updateInstanceSettings).not.toHaveBeenCalled();
    });
  });
});
