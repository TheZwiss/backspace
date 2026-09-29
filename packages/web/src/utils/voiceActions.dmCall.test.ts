import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub heavy / side-effectful imports pulled in transitively by utils/voice.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));
vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
}));
vi.mock('../hooks/useLiveKit', () => ({
  getActiveRoom: vi.fn(() => null),
}));

import { canStartDmCall, startDmCall, cancelOutgoingDmCall } from './voiceActions';
import { wsSend } from '../hooks/useWebSocket';
import { useVoiceStore } from '../stores/voiceStore';
import { useSpaceStore } from '../stores/spaceStore';

const DM = 'dm-1';
const REMOTE = 'https://remote.example';

function resetCallState(): void {
  useVoiceStore.setState({
    outgoingCall: null,
    incomingCall: null,
    activeDmCall: null,
    federatedCallId: null,
    callOrigin: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCallState();
  useSpaceStore.setState({ channelOriginMap: new Map([[DM, REMOTE]]) });
});

describe('canStartDmCall', () => {
  it('allows a call when nothing is ringing or active', () => {
    expect(canStartDmCall(useVoiceStore.getState())).toBe(true);
  });

  it.each([
    ['an outgoing call', { outgoingCall: { dmChannelId: 'other' } }],
    ['an active DM call', { activeDmCall: { dmChannelId: 'other' } }],
    ['an incoming call', { incomingCall: { dmChannelId: 'other', callerId: 'u', callerName: 'U' } }],
  ])('refuses while there is %s', (_label, state) => {
    useVoiceStore.setState(state);
    expect(canStartDmCall(useVoiceStore.getState())).toBe(false);
  });
});

describe('startDmCall', () => {
  it('marks the call outgoing and sends dm_call_start to the channel origin', () => {
    expect(startDmCall(DM)).toBe(true);
    expect(useVoiceStore.getState().outgoingCall).toEqual({ dmChannelId: DM });
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_start', dmChannelId: DM }, REMOTE);
  });

  it('routes a local DM to the home origin', () => {
    useSpaceStore.setState({ channelOriginMap: new Map() });
    startDmCall(DM);
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_start', dmChannelId: DM }, '');
  });

  it('sends nothing while an incoming call rings', () => {
    useVoiceStore.setState({ incomingCall: { dmChannelId: DM, callerId: 'u', callerName: 'U' } });
    expect(startDmCall(DM)).toBe(false);
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).not.toHaveBeenCalled();
  });

  it('sends nothing while another call is outgoing or active', () => {
    useVoiceStore.setState({ outgoingCall: { dmChannelId: 'other' } });
    expect(startDmCall(DM)).toBe(false);
    resetCallState();
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'other' } });
    expect(startDmCall(DM)).toBe(false);
    expect(wsSend).not.toHaveBeenCalled();
  });
});

describe('cancelOutgoingDmCall', () => {
  it('clears the outgoing call and sends dm_call_end to the channel origin', () => {
    useVoiceStore.setState({ outgoingCall: { dmChannelId: DM } });
    expect(cancelOutgoingDmCall(DM)).toBe(true);
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_end', dmChannelId: DM, federatedCallId: null }, REMOTE);
  });

  it('prefers the federated call origin and carries the federated call id', () => {
    useVoiceStore.setState({
      outgoingCall: { dmChannelId: DM },
      federatedCallId: 'remote-call',
      callOrigin: 'https://call-host.example',
    });
    cancelOutgoingDmCall(DM);
    expect(wsSend).toHaveBeenCalledWith(
      { type: 'dm_call_end', dmChannelId: DM, federatedCallId: 'remote-call' },
      'https://call-host.example',
    );
  });

  it('leaves a call ringing in another DM alone', () => {
    useVoiceStore.setState({ outgoingCall: { dmChannelId: 'other' } });
    expect(cancelOutgoingDmCall(DM)).toBe(false);
    expect(useVoiceStore.getState().outgoingCall).toEqual({ dmChannelId: 'other' });
    expect(wsSend).not.toHaveBeenCalled();
  });
});
