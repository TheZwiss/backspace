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

import { canStartDmCall, startDmCall, cancelOutgoingDmCall, isDmCallRunning, joinDmCall } from './voiceActions';
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
    voiceUsers: new Map(),
    connectFn: null,
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

describe('isDmCallRunning', () => {
  it('is true once someone is in the DM call', () => {
    useVoiceStore.setState({ voiceUsers: new Map([[DM, ['u1']]]) });
    expect(isDmCallRunning(useVoiceStore.getState(), DM)).toBe(true);
  });

  it('is false for a DM with nobody in a call', () => {
    useVoiceStore.setState({ voiceUsers: new Map([[DM, []], ['other', ['u1']]]) });
    expect(isDmCallRunning(useVoiceStore.getState(), DM)).toBe(false);
  });
});

describe('joinDmCall', () => {
  it('accepts the running call on the channel origin and connects at once', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ connectFn });
    expect(joinDmCall(DM)).toBe(true);
    expect(useVoiceStore.getState().activeDmCall).toEqual({ dmChannelId: DM });
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_accept', dmChannelId: DM }, REMOTE);
    expect(connectFn).toHaveBeenCalledWith(DM, true);
  });

  it('sends nothing while another call rings or runs', () => {
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'other' } });
    expect(joinDmCall(DM)).toBe(false);
    expect(wsSend).not.toHaveBeenCalled();
  });
  it('drops federated call data an earlier ring left, so the hang-up goes to the DM origin', () => {
    useVoiceStore.setState({ federatedCallId: 'fed-old', callOrigin: 'https://elsewhere.example' });
    expect(joinDmCall(DM)).toBe(true);
    expect(useVoiceStore.getState().federatedCallId).toBeNull();
    expect(useVoiceStore.getState().callOrigin).toBeNull();
  });
});
