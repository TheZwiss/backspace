import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub heavy / side-effectful imports pulled in transitively by utils/voice.
const audio = vi.hoisted(() => ({
  clearInputDenial: vi.fn(),
  resumeContext: vi.fn(() => Promise.resolve()),
  setInputDevice: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => audio },
}));
vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
}));
vi.mock('../hooks/useLiveKit', () => ({
  getActiveRoom: vi.fn(() => null),
}));

import {
  acceptIncomingDmCall, canStartDmCall, startDmCall, cancelOutgoingDmCall, handleDisconnectAction, isDmCallRunning, joinDmCall, reconnectVoice,
} from './voiceActions';
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
    ['an outgoing call', { outgoingCall: { dmChannelId: 'other', withCamera: false } }],
    ['an active DM call', { activeDmCall: { dmChannelId: 'other', federatedCallId: null, callOrigin: null, livekit: null } }],
    ['an incoming call', { incomingCall: { dmChannelId: 'other', federatedCallId: null, callOrigin: null, callerId: 'u', callerName: 'U', livekit: null } }],
  ])('refuses while there is %s', (_label, state) => {
    useVoiceStore.setState(state);
    expect(canStartDmCall(useVoiceStore.getState())).toBe(false);
  });
});

describe('startDmCall', () => {
  it('marks the call outgoing and sends dm_call_start to the channel origin', () => {
    expect(startDmCall(DM)).toBe(true);
    expect(useVoiceStore.getState().outgoingCall).toEqual({ dmChannelId: DM, withCamera: false });
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_start', dmChannelId: DM }, REMOTE);
  });

  it('arms the microphone inside the tap', () => {
    startDmCall(DM);
    expect(audio.clearInputDenial).toHaveBeenCalled();
    expect(audio.resumeContext).toHaveBeenCalled();
    expect(audio.setInputDevice).toHaveBeenCalled();
  });

  it('remembers that a video call was asked for', () => {
    startDmCall(DM, { withCamera: true });
    expect(useVoiceStore.getState().outgoingCall).toEqual({ dmChannelId: DM, withCamera: true });
  });

  it('routes a local DM to the home origin', () => {
    useSpaceStore.setState({ channelOriginMap: new Map() });
    startDmCall(DM);
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_start', dmChannelId: DM }, '');
  });

  it('sends nothing while an incoming call rings', () => {
    useVoiceStore.setState({ incomingCall: { dmChannelId: DM, federatedCallId: null, callOrigin: null, callerId: 'u', callerName: 'U', livekit: null } });
    expect(startDmCall(DM)).toBe(false);
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).not.toHaveBeenCalled();
  });

  it('sends nothing while another call is outgoing or active', () => {
    useVoiceStore.setState({ outgoingCall: { dmChannelId: 'other', withCamera: false } });
    expect(startDmCall(DM)).toBe(false);
    resetCallState();
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'other', federatedCallId: null, callOrigin: null, livekit: null } });
    expect(startDmCall(DM)).toBe(false);
    expect(wsSend).not.toHaveBeenCalled();
  });
});

describe('cancelOutgoingDmCall', () => {
  it('clears the outgoing call and sends dm_call_end to the channel origin', () => {
    useVoiceStore.setState({ outgoingCall: { dmChannelId: DM, withCamera: false } });
    expect(cancelOutgoingDmCall(DM)).toBe(true);
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_end', dmChannelId: DM, federatedCallId: null }, REMOTE);
  });

  it('is not routed by a ring that arrived meanwhile', () => {
    useVoiceStore.setState({
      outgoingCall: { dmChannelId: DM, withCamera: false },
      incomingCall: { dmChannelId: null, federatedCallId: 'remote-call', callOrigin: 'https://call-host.example', callerId: 'u', callerName: 'U', livekit: null },
    });
    cancelOutgoingDmCall(DM);
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_end', dmChannelId: DM, federatedCallId: null }, REMOTE);
  });

  it('leaves a call ringing in another DM alone', () => {
    useVoiceStore.setState({ outgoingCall: { dmChannelId: 'other', withCamera: false } });
    expect(cancelOutgoingDmCall(DM)).toBe(false);
    expect(useVoiceStore.getState().outgoingCall).toEqual({ dmChannelId: 'other', withCamera: false });
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
    expect(useVoiceStore.getState().activeDmCall).toEqual({ dmChannelId: DM, federatedCallId: null, callOrigin: null, livekit: null });
    expect(audio.setInputDevice).toHaveBeenCalled();
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_accept', dmChannelId: DM }, REMOTE);
    expect(connectFn).toHaveBeenCalledWith(DM, true);
  });

  it('sends nothing while another call rings or runs', () => {
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'other', federatedCallId: null, callOrigin: null, livekit: null } });
    expect(joinDmCall(DM)).toBe(false);
    expect(wsSend).not.toHaveBeenCalled();
  });
});

describe('acceptIncomingDmCall', () => {
  it('keeps the ring\'s key apart from the DM id, and answers where the ring came from', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({
      connectFn,
      incomingCall: {
        dmChannelId: null, federatedCallId: 'fed-1', callOrigin: 'https://home.example',
        callerId: 'u', callerName: 'U', livekit: { token: 'tok', url: 'wss://host/lk' },
      },
    });

    expect(acceptIncomingDmCall()).toBe(true);

    expect(useVoiceStore.getState().incomingCall).toBeNull();
    expect(useVoiceStore.getState().activeDmCall).toEqual({
      dmChannelId: null, federatedCallId: 'fed-1', callOrigin: 'https://home.example', livekit: { token: 'tok', url: 'wss://host/lk' },
    });
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_accept', dmChannelId: null, federatedCallId: 'fed-1' }, 'https://home.example');
    expect(connectFn).toHaveBeenCalledWith('fed-1', true);
    expect(audio.setInputDevice).toHaveBeenCalled();
  });

  it('does nothing when nothing rings', () => {
    expect(acceptIncomingDmCall()).toBe(false);
    expect(wsSend).not.toHaveBeenCalled();
  });
});

describe('hanging up a DM call', () => {
  it('sends the end with the call\'s own ids to the origin it goes through', () => {
    const disconnectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({
      disconnectFn,
      activeDmCall: { dmChannelId: null, federatedCallId: 'fed-1', callOrigin: 'https://home.example', livekit: null },
    });

    handleDisconnectAction();

    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_end', dmChannelId: null, federatedCallId: 'fed-1' }, 'https://home.example');
    expect(useVoiceStore.getState().activeDmCall).toBeNull();
    expect(disconnectFn).toHaveBeenCalled();
  });

  it('is not routed by a ring that arrived during the call', () => {
    useVoiceStore.setState({
      activeDmCall: { dmChannelId: DM, federatedCallId: null, callOrigin: null, livekit: null },
      incomingCall: { dmChannelId: null, federatedCallId: 'fed-2', callOrigin: 'https://elsewhere.example', callerId: 'u', callerName: 'U', livekit: null },
    });

    handleDisconnectAction();

    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_end', dmChannelId: DM, federatedCallId: null }, REMOTE);
  });
});

describe('reconnectVoice', () => {
  it('connects a DM call again under its room key', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({
      connectFn,
      activeDmCall: { dmChannelId: null, federatedCallId: 'fed-1', callOrigin: 'https://home.example', livekit: null },
    });

    reconnectVoice();

    expect(connectFn).toHaveBeenCalledWith('fed-1', true);
  });
});
