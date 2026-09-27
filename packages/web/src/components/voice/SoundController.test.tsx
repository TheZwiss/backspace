import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MessageWithUser, User, UserStatus } from '@backspace/shared';

const playSound = vi.hoisted(() => vi.fn());
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ playSound }) },
}));

import { SoundController } from './SoundController';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useVoiceStore } from '../../stores/voiceStore';

function loopSource() {
  return { stop: vi.fn() } as unknown as AudioBufferSourceNode;
}

function incoming(id: string, channelId = 'dm') {
  return {
    channelId,
    message: { id, channelId, userId: 'other', content: 'Hello' } as MessageWithUser,
  };
}

function soundsPlayed(): string[] {
  return playSound.mock.calls.map(([name]) => name as string);
}

function mountAs(status: UserStatus) {
  useAuthStore.setState({ user: { id: 'me', status } as User });
  const view = render(<SoundController />);
  act(() => vi.advanceTimersByTime(1000));
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  playSound.mockReset();
  playSound.mockImplementation(() => Promise.resolve(loopSource()));
  useSpaceStore.setState({ dmChannels: [{ id: 'dm' } as DmChannel] });
  useChatStore.setState({ realtimeMessageEvents: [] });
  useVoiceStore.setState({
    incomingCall: null,
    outgoingCall: null,
    isCameraOn: false,
    messageSoundAllChannels: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SoundController message sound', () => {
  it('plays for a DM while online', () => {
    mountAs('online');
    act(() => useChatStore.setState({ realtimeMessageEvents: [incoming('m1')] }));
    expect(soundsPlayed()).toEqual(['message']);
  });

  it('stays silent for a DM while on dnd', () => {
    mountAs('dnd');
    act(() => useChatStore.setState({ realtimeMessageEvents: [incoming('m1')] }));
    expect(soundsPlayed()).toEqual([]);
  });

  it('keeps playing once the 50-event buffer is full', () => {
    const full = Array.from({ length: 50 }, (_, i) => incoming(`old-${i}`));
    useChatStore.setState({ realtimeMessageEvents: full });
    mountAs('online');
    act(() => useChatStore.setState({ realtimeMessageEvents: [...full.slice(1), incoming('new')] }));
    expect(soundsPlayed()).toEqual(['message']);
  });
});

describe('SoundController incoming call ringing', () => {
  it('rings while online', async () => {
    mountAs('online');
    await act(async () => {
      useVoiceStore.setState({ incomingCall: { dmChannelId: 'dm', callerId: 'other', callerName: 'Other' } });
    });
    expect(soundsPlayed()).toEqual(['call_ringing']);
    act(() => useVoiceStore.setState({ incomingCall: null }));
  });

  it('does not ring while on dnd', async () => {
    mountAs('dnd');
    await act(async () => {
      useVoiceStore.setState({ incomingCall: { dmChannelId: 'dm', callerId: 'other', callerName: 'Other' } });
    });
    expect(soundsPlayed()).toEqual([]);
    act(() => useVoiceStore.setState({ incomingCall: null }));
  });
});

describe('SoundController ringing follows the status while a call rings', () => {
  const call = { dmChannelId: 'dm', callerId: 'other', callerName: 'Other' };

  it('stops the ring when the user switches to dnd mid-ring', async () => {
    const source = loopSource();
    playSound.mockImplementation(() => Promise.resolve(source));
    mountAs('online');
    await act(async () => { useVoiceStore.setState({ incomingCall: call }); });
    expect(soundsPlayed()).toEqual(['call_ringing']);

    await act(async () => { useAuthStore.setState({ user: { id: 'me', status: 'dnd' } as User }); });
    expect(source.stop).toHaveBeenCalledOnce();
    act(() => useVoiceStore.setState({ incomingCall: null }));
  });

  it('starts the ring when the user leaves dnd while the call is still ringing', async () => {
    mountAs('dnd');
    await act(async () => { useVoiceStore.setState({ incomingCall: call }); });
    expect(soundsPlayed()).toEqual([]);

    await act(async () => { useAuthStore.setState({ user: { id: 'me', status: 'online' } as User }); });
    expect(soundsPlayed()).toEqual(['call_ringing']);
    act(() => useVoiceStore.setState({ incomingCall: null }));
  });

  it('does not start a second loop when an unrelated user field changes', async () => {
    mountAs('online');
    await act(async () => { useVoiceStore.setState({ incomingCall: call }); });
    await act(async () => { useAuthStore.setState({ user: { id: 'me', status: 'online', bio: 'x' } as User }); });
    expect(soundsPlayed()).toEqual(['call_ringing']);
    act(() => useVoiceStore.setState({ incomingCall: null }));
  });
});

describe('SoundController ringing when a cue never loads', () => {
  const call = { dmChannelId: 'dm', callerId: 'other', callerName: 'Other' };

  it('rings for the next call after a playSound that never settled', async () => {
    let settleFirst: (source: AudioBufferSourceNode | null) => void = () => {};
    const first = loopSource();
    playSound.mockImplementationOnce(() => new Promise((resolve) => { settleFirst = resolve; }));
    mountAs('online');

    await act(async () => { useVoiceStore.setState({ incomingCall: call }); });
    await act(async () => { useVoiceStore.setState({ incomingCall: null }); });
    await act(async () => { useVoiceStore.setState({ incomingCall: { ...call } }); });
    expect(soundsPlayed()).toEqual(['call_ringing', 'call_ringing']);

    // The abandoned load finally lands: it must not become a second loop.
    await act(async () => { settleFirst(first); });
    expect(first.stop).toHaveBeenCalledOnce();
    act(() => useVoiceStore.setState({ incomingCall: null }));
  });
});

describe('SoundController own-action cues', () => {
  it('still plays the camera cue on dnd: it is feedback, not a notification', () => {
    mountAs('dnd');
    act(() => useVoiceStore.setState({ isCameraOn: true }));
    expect(soundsPlayed()).toEqual(['camera_on']);
  });
});
