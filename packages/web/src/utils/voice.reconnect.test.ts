import { beforeEach, describe, expect, it, vi } from 'vitest';

const wsSend = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useWebSocket', () => ({ wsSend }));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: () => ({
      clearInputDenial: vi.fn(),
      resumeContext: vi.fn().mockResolvedValue(undefined),
      setInputDevice: vi.fn().mockResolvedValue(null),
    }),
  },
}));

import { useVoiceStore } from '../stores/voiceStore';
import { useSpaceStore } from '../stores/spaceStore';
import { broadcastVoiceStatus, joinVoiceChannel } from './voice';

describe('voice status resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceStore.setState({
      ...useVoiceStore.getInitialState(),
      currentVoiceChannelId: null,
      activeDmCall: { dmChannelId: 'dm-reconnect', federatedCallId: null, callOrigin: 'https://calls.example', livekit: null },
      isMuted: true,
      isDeafened: false,
      isCameraOn: true,
      isScreenSharing: false,
    });
  });

  it('sends voice_status for an active DM even though space channel state is null', () => {
    broadcastVoiceStatus();

    expect(wsSend).toHaveBeenCalledWith({
      type: 'voice_status',
      isMuted: true,
      isDeafened: false,
      isCameraOn: true,
      isScreenSharing: false,
    }, 'https://calls.example');
  });
});

describe('rejoining a dropped session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceStore.setState({
      ...useVoiceStore.getInitialState(),
      currentVoiceChannelId: 'channel-1',
      activeDmCall: null,
    });
  });

  it('reconnects when the retained channel is selected again after a drop', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ voiceConnectionStatus: 'disconnected' });

    joinVoiceChannel('channel-1', connectFn);

    expect(connectFn).toHaveBeenCalledWith('channel-1');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel-1');
  });

  it('stays a no-op while the session is still live', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ voiceConnectionStatus: 'connected' });

    joinVoiceChannel('channel-1', connectFn);

    expect(connectFn).not.toHaveBeenCalled();
  });

  it('stays a no-op while the session is still reconnecting on its own', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ voiceConnectionStatus: 'reconnecting' });

    joinVoiceChannel('channel-1', connectFn);

    expect(connectFn).not.toHaveBeenCalled();
  });
});

describe('joining a voice channel while in a DM call through another instance', () => {
  const CALL_ORIGIN = 'https://peer.example';

  beforeEach(() => {
    vi.clearAllMocks();
    useSpaceStore.setState({ channelOriginMap: new Map([['channel-1', '']]) });
    useVoiceStore.setState({ ...useVoiceStore.getInitialState(), currentVoiceChannelId: null });
  });

  it('leaves the call there, which hears nothing else of the join', () => {
    useVoiceStore.setState({ activeDmCall: { dmChannelId: null, federatedCallId: 'key-1', callOrigin: CALL_ORIGIN, livekit: null } });

    joinVoiceChannel('channel-1', vi.fn().mockResolvedValue(undefined));

    expect(wsSend).toHaveBeenCalledWith({ type: 'voice_leave' }, CALL_ORIGIN);
    expect(useVoiceStore.getState().activeDmCall).toBeNull();
  });

  it('cancels a call still ringing there', () => {
    useSpaceStore.setState({ channelOriginMap: new Map([['channel-1', ''], ['dm-1', CALL_ORIGIN]]) });
    useVoiceStore.setState({ outgoingCall: { dmChannelId: 'dm-1', withCamera: false } });

    joinVoiceChannel('channel-1', vi.fn().mockResolvedValue(undefined));

    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_end', dmChannelId: 'dm-1', federatedCallId: null }, CALL_ORIGIN);
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
  });

  it('leaves a call through the channel\'s own instance to that instance\'s voice_join', () => {
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'dm-1', federatedCallId: null, callOrigin: '', livekit: null } });

    joinVoiceChannel('channel-1', vi.fn().mockResolvedValue(undefined));

    expect(wsSend).not.toHaveBeenCalledWith({ type: 'voice_leave' }, expect.anything());
  });
});
