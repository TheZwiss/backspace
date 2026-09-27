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

const remoteClient = vi.hoisted(() => ({ settings: { getStreaming: vi.fn() } }));
vi.mock('./crossStoreResolvers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crossStoreResolvers')>();
  return {
    ...actual,
    getApiForOrigin: (origin: string) => (origin ? remoteClient : actual.getApiForOrigin(origin)),
  };
});

import { getStreamHostLimits, refreshStreamHostLimits, voiceHostOrigin } from './streamHostLimits';
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

describe('getStreamHostLimits', () => {
  it('keeps using home limits for a home voice channel', () => {
    useSettingsStore.setState({ streamingLimitsByOrigin: { [REMOTE]: REMOTE_LIMITS } });
    useVoiceStore.setState({ currentVoiceChannelId: 'vc-home' });
    expect(getStreamHostLimits()).toEqual(HOME_LIMITS);
  });

  it('falls back to the defaults, never to home, while the host has not answered', () => {
    useSettingsStore.setState({ streamingLimits: { ...HOME_LIMITS, maxBitrateKbps: 1000 } });
    useVoiceStore.setState({ currentVoiceChannelId: 'vc-remote' });
    // Home's 1 Mbps cap says nothing about the remote host.
    expect(getStreamHostLimits().maxBitrateKbps).toBe(20000);
  });

  it('treats a DM call as hosted at home', () => {
    expect(voiceHostOrigin(null, new Map([['vc-remote', REMOTE]]))).toBe('');
  });
});

describe('refreshStreamHostLimits', () => {
  it('asks the host instance for its document and stores it under that origin', async () => {
    remoteClient.settings.getStreaming.mockResolvedValue(REMOTE_LIMITS);
    await refreshStreamHostLimits(REMOTE);
    expect(remoteClient.settings.getStreaming).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().streamingLimitsByOrigin[REMOTE]).toEqual(REMOTE_LIMITS);
    // Home's document is untouched: it also carries home's discovery flags.
    expect(useSettingsStore.getState().streamingLimits).toEqual(HOME_LIMITS);
  });

  it('keeps the last document the host sent when a refresh fails', async () => {
    // An older answer from the host is still that host's policy; the defaults
    // are nobody's.
    useSettingsStore.setState({ streamingLimitsByOrigin: { [REMOTE]: REMOTE_LIMITS } });
    remoteClient.settings.getStreaming.mockRejectedValue(new Error('offline'));
    await refreshStreamHostLimits(REMOTE);
    expect(useSettingsStore.getState().streamingLimitsByOrigin[REMOTE]).toEqual(REMOTE_LIMITS);
  });

  it('does nothing for home, whose document the ready handler already keeps', async () => {
    await refreshStreamHostLimits('');
    expect(remoteClient.settings.getStreaming).not.toHaveBeenCalled();
  });
});
