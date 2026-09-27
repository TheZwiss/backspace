import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InstanceStreamingLimits } from '@backspace/shared';

// Only the stores and the limit resolution are real here; the rest of the
// module graph screenShare.ts pulls in is stubbed like the stop-path tests.
vi.mock('./voice', () => ({ broadcastVoiceStatus: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('./livekitInternals', () => ({ getPublisherPC: vi.fn(), getMediaStreamTrack: vi.fn() }));
vi.mock('./hwOverdrive', () => ({ activate: vi.fn(), deactivate: vi.fn() }));
vi.mock('../stores/screenShareSetupStore', () => ({ openScreenShareSetup: vi.fn() }));


import { buildScreenShareOptions } from './screenShare';
import { useSettingsStore } from '../stores/settingsStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useVoiceStore } from '../stores/voiceStore';

const REMOTE = 'https://remote.example';

const HOME_LIMITS: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080],
  allowedFramerates: [30, 45, 60],
  maxResolution: 1080,
  maxFramerate: 60,
  discoveryEnabled: true,
  directoryEnabled: false,
  directoryConfigured: false,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
};

const REMOTE_LIMITS: InstanceStreamingLimits = {
  ...HOME_LIMITS,
  maxBitrateKbps: 3000,
  minBitrateKbps: 1000,
  allowedResolutions: [540, 720],
  allowedFramerates: [30],
  maxResolution: 720,
  maxFramerate: 30,
  allowCustomBitrate: false,
};

const CONFIG = { height: 1080, fps: 60, mode: 'gaming', customBitrateKbps: null, shareAudio: false, codec: 'vp9' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  useSpaceStore.setState({ channelOriginMap: new Map([['vc-home', ''], ['vc-remote', REMOTE]]) });
  useSettingsStore.setState({ streamingLimits: HOME_LIMITS, streamingLimitsByOrigin: {} });
  useVoiceStore.setState({ currentVoiceChannelId: null, screenShareConfig: { ...CONFIG } });
});

describe('a screen share follows the limits of the instance hosting the voice channel', () => {
  it('clamps the bitrate to the host instance, not the home instance', () => {
    useSettingsStore.setState({ streamingLimitsByOrigin: { [REMOTE]: REMOTE_LIMITS } });
    useVoiceStore.setState({ currentVoiceChannelId: 'vc-remote' });

    // 1080p60 resolves to 8 Mbps from the matrix. Home allows 20 Mbps; the
    // host whose LiveKit carries the stream allows 3.
    const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
    expect(opts.publish.videoEncoding.maxBitrate).toBe(3_000_000);
    expect(opts.overdrive.maxBitrate).toBe(3_000_000);
  });

  it('ignores a custom bitrate when the host does not allow one', () => {
    useSettingsStore.setState({ streamingLimitsByOrigin: { [REMOTE]: REMOTE_LIMITS } });
    useVoiceStore.setState({
      currentVoiceChannelId: 'vc-remote',
      screenShareConfig: { ...CONFIG, height: 540, fps: 30, customBitrateKbps: 2500 },
    });
    const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
    // Matrix default for 540p30, not the custom 2.5 Mbps home would allow.
    expect(opts.publish.videoEncoding.maxBitrate).toBe(1_500_000);
  });

});
