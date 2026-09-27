import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { InstanceStreamingLimits } from '@backspace/shared';
import { StreamQualityControls } from './StreamQualityControls';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useSettingsStore } from '../../stores/settingsStore';

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
  useSpaceStore.setState({ channelOriginMap: new Map([['vc-home', ''], ['vc-remote', REMOTE]]) });
  useSettingsStore.setState({ streamingLimits: HOME_LIMITS, streamingLimitsByOrigin: { [REMOTE]: REMOTE_LIMITS } });
  useVoiceStore.setState({
    currentVoiceChannelId: 'vc-remote',
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

  it('names the host whose limits apply', () => {
    render(<StreamQualityControls />);
    expect(screen.getByText('Limits set by remote.example')).toBeInTheDocument();
  });

  it('clamps a persisted config to the host limits', () => {
    useVoiceStore.setState({
      screenShareConfig: { height: 1080, fps: 60, mode: 'gaming', customBitrateKbps: null, shareAudio: false, codec: 'vp9' },
    });
    render(<StreamQualityControls />);
    const { height, fps } = useVoiceStore.getState().screenShareConfig;
    expect(height).toBe(720);
    expect(fps).toBe(30);
  });

  it('uses home limits in a home channel and names no host', () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'vc-home' });
    render(<StreamQualityControls />);
    expect(screen.getByRole('button', { name: '1440p' })).toBeInTheDocument();
    expect(screen.queryByText(/Limits set by/)).not.toBeInTheDocument();
  });
});

describe('StreamQualityControls System Audio while live', () => {
  function audioSwitch() {
    return screen.getByRole('switch', { name: 'System Audio' });
  }

  beforeEach(() => {
    useVoiceStore.setState({ currentVoiceChannelId: 'vc-home' });
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
  });

  it('can always be turned off while audio is published', () => {
    useVoiceStore.setState({ isScreenSharing: true, screenShareAudio: 'published' });
    render(<StreamQualityControls />);
    expect(audioSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(audioSwitch()).toBeEnabled();
  });
});
