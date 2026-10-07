import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { InstanceStreamingLimits } from '@backspace/shared';
import { StreamQualityControls, StreamHostSubtitle } from './StreamQualityControls';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { resetSystemAudioCapabilityForTests } from '../../utils/systemAudioNote';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

const REMOTE = 'https://remote.example';

const HOME_LIMITS: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080, 1440],
  allowedFramerates: [30, 60, 120],
  maxResolution: 1440,
  maxFramerate: 120,
  discoveryEnabled: true,
  directoryEnabled: false,
  directoryConfigured: false,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
};

const REMOTE_LIMITS: InstanceStreamingLimits = {
  ...HOME_LIMITS,
  maxBitrateKbps: 3000,
  allowedResolutions: [540, 720],
  allowedFramerates: [30],
  maxResolution: 720,
  maxFramerate: 30,
  allowCustomBitrate: false,
};

beforeEach(() => {
  useSettingsStore.setState({ streamingLimits: HOME_LIMITS, streamingLimitsByOrigin: { [REMOTE]: REMOTE_LIMITS } });
  useVoiceStore.setState({
    livekitHostOrigin: REMOTE,
    isScreenSharing: false,
    screenShareConfig: { height: 720, fps: 30, mode: 'gaming', customBitrateKbps: null, shareAudio: false, codec: 'vp9' },
  });
});

describe('StreamQualityControls in a federated voice channel', () => {
  it('offers only what the host instance allows', () => {
    render(<StreamQualityControls />);
    expect(screen.getByRole('button', { name: '720p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1080p' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '60' })).not.toBeInTheDocument();
    // The host turned custom bitrates off, so there is no Custom pill.
    expect(screen.queryByRole('button', { name: 'Custom' })).not.toBeInTheDocument();
  });

  it('names the host in the custom-bitrate line', () => {
    render(<StreamQualityControls />);
    expect(screen.getByText('Custom bitrate turned off by remote.example')).toBeInTheDocument();
  });

  it('highlights the effective values and leaves the saved settings alone', () => {
    const saved = { height: 1080, fps: 60, mode: 'gaming', customBitrateKbps: null, shareAudio: false, codec: 'vp9' } as const;
    useVoiceStore.setState({ screenShareConfig: { ...saved } });
    render(<StreamQualityControls />);
    expect(screen.getByRole('button', { name: '720p' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '30' })).toHaveAttribute('aria-pressed', 'true');
    expect(useVoiceStore.getState().screenShareConfig).toEqual(saved);
  });

  it('saves only what the user clicks', () => {
    useVoiceStore.setState({
      screenShareConfig: { height: 1080, fps: 60, mode: 'gaming', customBitrateKbps: null, shareAudio: false, codec: 'vp9' },
    });
    render(<StreamQualityControls />);
    fireEvent.click(screen.getByRole('button', { name: '540p' }));
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({ height: 540, fps: 60 });
  });

  it('uses home limits in a home channel', () => {
    useVoiceStore.setState({ livekitHostOrigin: '' });
    render(<StreamQualityControls />);
    expect(screen.getByRole('button', { name: '1440p' })).toBeInTheDocument();
  });
});

describe('StreamHostSubtitle', () => {
  it('names the host whose limits apply', () => {
    render(<StreamHostSubtitle />);
    expect(screen.getByText('Limits set by remote.example')).toBeInTheDocument();
  });

  it('is absent at home', () => {
    useVoiceStore.setState({ livekitHostOrigin: '' });
    const { container } = render(<StreamHostSubtitle />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('StreamQualityControls System Audio while live', () => {
  function audioSwitch() {
    return screen.getByRole('switch', { name: 'System Audio' });
  }

  beforeEach(() => {
    useVoiceStore.setState({ livekitHostOrigin: '' });
  });

  it('shows what the share sends, not the preference', () => {
    // Chrome's picker let the user untick audio: the preference is on, the share has none.
    useVoiceStore.setState({
      isScreenSharing: true,
      screenShareAudio: 'unavailable',
      screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, shareAudio: true },
    });
    render(<StreamQualityControls />);
    expect(audioSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('is disabled and explains itself where audio cannot be added mid-stream', () => {
    useVoiceStore.setState({ isScreenSharing: true, screenShareAudio: 'unavailable' });
    render(<StreamQualityControls />);
    expect(audioSwitch()).toBeDisabled();
    expect(screen.getByText(/System audio can only be added when a stream starts/)).toBeInTheDocument();
  });

  it('can be turned back on when the capture is held', () => {
    useVoiceStore.setState({ isScreenSharing: true, screenShareAudio: 'held' });
    render(<StreamQualityControls />);
    expect(audioSwitch()).toBeEnabled();
    expect(audioSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(/can only be added when a stream starts/)).not.toBeInTheDocument();
  });

  it('can be turned on where the desktop app can add loopback audio', () => {
    useVoiceStore.setState({ isScreenSharing: true, screenShareAudio: 'acquirable' });
    render(<StreamQualityControls />);
    expect(audioSwitch()).toBeEnabled();
  });

  it('reads as on and waits while the audio is being captured', () => {
    useVoiceStore.setState({ isScreenSharing: true, screenShareAudio: 'acquiring' });
    render(<StreamQualityControls />);
    expect(audioSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(audioSwitch()).toBeDisabled();
    expect(screen.getByText('Adding system audio…')).toBeInTheDocument();
  });

  it('can always be turned off while audio is published', () => {
    useVoiceStore.setState({ isScreenSharing: true, screenShareAudio: 'published' });
    render(<StreamQualityControls />);
    expect(audioSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(audioSwitch()).toBeEnabled();
  });
});

describe('the System Audio note in the desktop app', () => {
  // Whether System Audio carries the voice chat to viewers depends on the OS
  // build, which only the desktop app's main process can tell.
  function asDesktop(platform: string, capability?: OwnAudioInSystemAudio) {
    const api: Partial<BackspaceElectronAPI> = { platform };
    if (capability) api.getSystemAudioCapability = () => Promise.resolve(capability);
    window.backspace = api as BackspaceElectronAPI;
  }

  beforeEach(() => { resetSystemAudioCapabilityForTests(); });
  afterEach(() => {
    delete (window as { backspace?: BackspaceElectronAPI }).backspace;
    resetSystemAudioCapabilityForTests();
  });

  it('warns on Windows 10 before System Audio is turned on', async () => {
    asDesktop('win32', 'included');
    render(<StreamQualityControls />);
    expect(await screen.findByText(/viewers will hear their own voices/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'System Audio' })).toHaveAttribute('aria-checked', 'false');
  });

  it('says the voice chat is left out on Windows 11 once System Audio is on', async () => {
    asDesktop('win32', 'excluded');
    useVoiceStore.setState({ screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, shareAudio: true } });
    render(<StreamQualityControls />);
    expect(await screen.findByText(/but not the voice chat/)).toBeInTheDocument();
  });

  it('keeps the older note with a desktop app that cannot tell', async () => {
    asDesktop('win32');
    useVoiceStore.setState({ screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, shareAudio: true } });
    render(<StreamQualityControls />);
    expect(await screen.findByText(/Windows loopback may capture call audio/)).toBeInTheDocument();
  });
});
