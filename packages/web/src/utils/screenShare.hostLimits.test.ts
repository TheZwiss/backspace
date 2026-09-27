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


import { buildScreenShareOptions, effectiveScreenShareConfig } from './screenShare';
import { useSettingsStore } from '../stores/settingsStore';
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
  useSettingsStore.setState({ streamingLimits: HOME_LIMITS, streamingLimitsByOrigin: {} });
  useVoiceStore.setState({ livekitHostOrigin: '', screenShareConfig: { ...CONFIG } });
});

describe('a screen share follows the limits of the instance hosting the voice channel', () => {
  it('clamps the bitrate to the host instance, not the home instance', () => {
    useSettingsStore.setState({ streamingLimitsByOrigin: { [REMOTE]: REMOTE_LIMITS } });
    useVoiceStore.setState({ livekitHostOrigin: REMOTE });

    // 1080p60 resolves to 8 Mbps from the matrix. Home allows 20 Mbps; the
    // host whose LiveKit carries the stream allows 3.
    const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
    expect(opts.publish.videoEncoding.maxBitrate).toBe(3_000_000);
    expect(opts.overdrive.maxBitrate).toBe(3_000_000);
  });

  it('ignores a custom bitrate when the host does not allow one', () => {
    useSettingsStore.setState({ streamingLimitsByOrigin: { [REMOTE]: REMOTE_LIMITS } });
    useVoiceStore.setState({
      livekitHostOrigin: REMOTE,
      screenShareConfig: { ...CONFIG, height: 540, fps: 30, customBitrateKbps: 2500 },
    });
    const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
    // Matrix default for 540p30, not the custom 2.5 Mbps home would allow.
    expect(opts.publish.videoEncoding.maxBitrate).toBe(1_500_000);
  });

});

describe('effectiveScreenShareConfig derives what a stream uses; the saved choice stays the user\'s', () => {
  const saved = { height: 1080, fps: 60, mode: 'text', customBitrateKbps: 2500, shareAudio: true, codec: 'h264' } as const;

  it('moves height and frame rate to the nearest allowed value', () => {
    const eff = effectiveScreenShareConfig(saved, REMOTE_LIMITS);
    expect(eff).toMatchObject({ height: 720, fps: 30, mode: 'text', shareAudio: true, codec: 'h264' });
  });

  it('drops a custom bitrate the host does not allow, and clamps one it does', () => {
    expect(effectiveScreenShareConfig(saved, REMOTE_LIMITS).customBitrateKbps).toBeNull();
    const allowing = { ...REMOTE_LIMITS, allowCustomBitrate: true };
    expect(effectiveScreenShareConfig({ ...saved, customBitrateKbps: 9000 }, allowing).customBitrateKbps).toBe(3000);
    expect(effectiveScreenShareConfig({ ...saved, customBitrateKbps: 200 }, allowing).customBitrateKbps).toBe(1000);
  });

  it('falls back from native to the highest allowed height, and to native when only native is left', () => {
    expect(effectiveScreenShareConfig({ ...saved, height: 'native' }, REMOTE_LIMITS).height).toBe(720);
    expect(effectiveScreenShareConfig(saved, { ...REMOTE_LIMITS, allowedResolutions: ['native'] }).height).toBe('native');
  });

  it('leaves a value alone when its allowlist is empty', () => {
    const empty = { ...REMOTE_LIMITS, allowedResolutions: [], allowedFramerates: [] };
    expect(effectiveScreenShareConfig(saved, empty)).toMatchObject({ height: 1080, fps: 60 });
  });

  it('returns the saved object untouched when it already fits', () => {
    expect(effectiveScreenShareConfig(saved, HOME_LIMITS)).toBe(saved);
  });

  it('gives a strict host its caps, then home its own, without the saved settings moving', () => {
    useSettingsStore.setState({ streamingLimitsByOrigin: { [REMOTE]: REMOTE_LIMITS } });
    useVoiceStore.setState({ livekitHostOrigin: REMOTE, screenShareConfig: { ...saved } });

    const atHost = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
    expect(atHost.capture).toMatchObject({ height: 720, frameRate: 30 });
    expect(atHost.publish.videoEncoding.maxBitrate).toBe(3_000_000);

    useVoiceStore.setState({ livekitHostOrigin: '' });
    const atHome = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
    expect(atHome.capture).toMatchObject({ height: 1080, frameRate: 60 });
    expect(atHome.publish.videoEncoding.maxBitrate).toBe(2_500_000);

    expect(useVoiceStore.getState().screenShareConfig).toEqual(saved);
  });
});
