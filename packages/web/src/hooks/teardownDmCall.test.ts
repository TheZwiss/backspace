import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub heavy import leaves so useWebSocket can be imported in jsdom without
// pulling in the LiveKit SDK / AudioWorklet graph. teardownDmCall only touches
// voiceStore, which we exercise for real.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));
vi.mock('./useLiveKit', () => ({
  getActiveRoom: () => null,
}));

import { teardownDmCall } from './useWebSocket';
import { useVoiceStore } from '../stores/voiceStore';

describe('teardownDmCall', () => {
  beforeEach(() => {
    useVoiceStore.setState({
      currentVoiceChannelId: null,
      activeDmCall: null,
      incomingCall: null,
      outgoingCall: null,
      federatedCallToken: null,
      federatedCallUrl: null,
      federatedCallId: null,
      callOrigin: null,
      disconnectFn: null,
    });
  });

  // Regression: the last participant to leave a DM call for a space voice
  // channel receives a `dm_call_ended` echo (the server emptied the DM room).
  // teardownDmCall must NOT tear down the space connection that was just
  // established — otherwise the UI is stranded on "Connecting…".
  it('does NOT disconnect when the user has joined a space voice channel', () => {
    const disconnectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({
      currentVoiceChannelId: 'space-voice-1',
      activeDmCall: null,
      disconnectFn,
    });

    teardownDmCall();

    expect(disconnectFn).not.toHaveBeenCalled();
    // The space voice intent is preserved.
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('space-voice-1');
  });

  it('DOES disconnect when still in the DM call (no space channel)', () => {
    const disconnectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({
      currentVoiceChannelId: null,
      activeDmCall: { dmChannelId: 'dm-1' },
      disconnectFn,
    });

    teardownDmCall();

    expect(disconnectFn).toHaveBeenCalledTimes(1);
    // DM call state is cleared.
    expect(useVoiceStore.getState().activeDmCall).toBeNull();
  });

  it('clears residual incoming/outgoing/federated call state regardless', () => {
    const disconnectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({
      currentVoiceChannelId: 'space-voice-1',
      incomingCall: { dmChannelId: 'dm-2', callerId: 'u9', callerName: 'Nine' },
      outgoingCall: { dmChannelId: 'dm-3' },
      federatedCallId: 'fed-1',
      disconnectFn,
    });

    teardownDmCall();

    const s = useVoiceStore.getState();
    expect(s.incomingCall).toBeNull();
    expect(s.outgoingCall).toBeNull();
    expect(s.federatedCallId).toBeNull();
    expect(disconnectFn).not.toHaveBeenCalled();
  });
});
