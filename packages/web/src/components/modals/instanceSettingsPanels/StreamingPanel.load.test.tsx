import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceStreamingLimits } from '@backspace/shared';
import { StreamingPanel } from './StreamingPanel';
import { useSettingsStore } from '../../../stores/settingsStore';
import { api } from '../../../api/client';

const LIMITS: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080],
  allowedFramerates: [30, 45, 60],
  maxResolution: 1080,
  maxFramerate: 60,
  discoveryEnabled: true,
  directoryEnabled: false,
  directoryConfigured: true,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
};

const FAILED = 'Could not load the settings.';

beforeEach(() => {
  // Spies on `api.settings` outlive a test and keep their call history, so a
  // count in the second test would include the first one's calls.
  vi.restoreAllMocks();
  // The document starts unknown, which is what a failed fetch also leaves
  // behind: the store no longer substitutes defaults an admin could save over
  // the instance's real configuration.
  useSettingsStore.setState({ streamingLimits: null });
});

describe('StreamingPanel loading', () => {
  it('says the load failed and offers a retry instead of loading forever', async () => {
    const get = vi.spyOn(api.settings, 'getStreaming').mockRejectedValue(new Error('offline'));
    render(<StreamingPanel />);

    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByText('Loading settings…')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().streamingLimits).toBeNull();
  });

  it('retry loads the document and the panel takes over', async () => {
    // Persistent mocks, not `...Once`: a consumed queue falls through to the
    // real request, which would make the count depend on the network.
    const get = vi.spyOn(api.settings, 'getStreaming').mockRejectedValue(new Error('offline'));
    render(<StreamingPanel />);
    await screen.findByText(FAILED);

    get.mockResolvedValue(LIMITS);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByText(FAILED)).not.toBeInTheDocument());
    expect(get).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().streamingLimits).toEqual(LIMITS);
  });

  it('a retry in flight keeps the failure line, with the button disabled', async () => {
    const get = vi.spyOn(api.settings, 'getStreaming').mockRejectedValue(new Error('offline'));
    render(<StreamingPanel />);
    await screen.findByText(FAILED);

    let finish: (limits: InstanceStreamingLimits) => void = () => {};
    get.mockImplementationOnce(() => new Promise<InstanceStreamingLimits>((resolve) => { finish = resolve; }));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // The admin stays where they clicked: no bounce back to the spinner, and
    // the button they just used is visibly out of action.
    expect(screen.getByText(FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(screen.queryByText('Loading settings…')).not.toBeInTheDocument();

    finish(LIMITS);
    await waitFor(() => expect(screen.queryByText(FAILED)).not.toBeInTheDocument());
  });

  it('a load that works never shows the failure line', async () => {
    vi.spyOn(api.settings, 'getStreaming').mockResolvedValue(LIMITS);
    render(<StreamingPanel />);

    await waitFor(() => expect(useSettingsStore.getState().streamingLimits).toEqual(LIMITS));
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });
});
