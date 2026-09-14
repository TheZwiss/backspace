import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VoiceChannel } from './VoiceChannel';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useVoiceStore } from '../../stores/voiceStore';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

function participant(userId: string, username: string, isLocal: boolean) {
  return {
    identity: `${userId}:${username}`,
    userId,
    username,
    homeUserId: null,
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
    isLocal,
    audioTrack: null,
    videoTrack: null,
    screenTrack: null,
    screenAudioTrack: null,
    lkVideoTrack: null,
    lkScreenTrack: null,
    cachedUser: null,
  } as any;
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: '1', username: 'ada' } } as any);
  useSpaceStore.setState({
    members: [
      { userId: '1', user: { id: '1', username: 'ada', displayName: 'Ada', avatar: null }, roles: [] },
      { userId: '2', user: { id: '2', username: 'bob', displayName: 'Bob', avatar: null }, roles: [] },
    ],
    channelToSpaceMap: new Map([['voice-1', 'space-1']]),
  } as any);
  useVoiceStore.setState({
    currentVoiceChannelId: 'voice-1',
    isLiveKitConnected: true,
    voiceConnectionStatus: 'connected',
    participants: [participant('1', 'ada', true), participant('2', 'bob', false)],
    voiceUsers: new Map([['voice-1', ['1', '2']]]),
    voiceChannelElapsedSeconds: new Map(),
    voiceUserStates: new Map(),
    connectionQuality: 'good',
    connectionQualities: new Map(),
    spaceMutedUserIds: new Set(),
    spaceDeafenedUserIds: new Set(),
    permissionMutedUserIds: new Set(),
    participantMutes: new Map(),
    unwatchedCameras: new Set(),
    speakingUserIds: new Set(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderChannel(canManage = false, onSettingsClick = () => {}) {
  return render(
    <VoiceChannel
      channelId="voice-1"
      channelName="Voice"
      onClick={() => {}}
      canManage={canManage}
      onSettingsClick={onSettingsClick}
    />,
  );
}

describe('VoiceChannel connection diagnostics', () => {
  it('attributes a poor remote connection to that participant', () => {
    useVoiceStore.setState({
      connectionQualities: new Map([['2:bob', 'poor']]),
    });

    renderChannel();

    expect(screen.getByLabelText('Bob has an unstable connection')).toBeInTheDocument();
  });

  it('shows a voice-server reconnect warning on the local participant', () => {
    useVoiceStore.setState({ voiceConnectionStatus: 'reconnecting' });

    renderChannel();

    expect(screen.getByLabelText('Connection to the voice server was interrupted — reconnecting…')).toBeInTheDocument();
  });
});

describe('VoiceChannel occupancy timer', () => {
  it('shows and updates the server-authoritative channel duration even when viewing another channel', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2038-01-19T03:14:07Z'));
    useVoiceStore.setState({
      currentVoiceChannelId: 'voice-2',
      voiceChannelElapsedSeconds: new Map([['voice-1', {
        elapsedSeconds: 65,
        observedAt: Date.now(),
      }]]),
    });

    renderChannel();

    expect(screen.getByTestId('voice-channel-timer')).toHaveTextContent('01:05');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('voice-channel-timer')).toHaveTextContent('01:06');
  });

  it('clears the server duration only when the channel becomes empty', () => {
    const observation = { elapsedSeconds: 65, observedAt: Date.now() };
    useVoiceStore.setState({ voiceChannelElapsedSeconds: new Map([['voice-1', observation]]) });

    useVoiceStore.getState().removeVoiceUser('voice-1', '2');
    expect(useVoiceStore.getState().voiceChannelElapsedSeconds.get('voice-1')).toBe(observation);

    useVoiceStore.getState().removeVoiceUser('voice-1', '1');
    expect(useVoiceStore.getState().voiceChannelElapsedSeconds.has('voice-1')).toBe(false);
  });

  it('overlays channel settings without reserving space beside the timer', () => {
    useVoiceStore.setState({
      voiceChannelElapsedSeconds: new Map([['voice-1', {
        elapsedSeconds: 0,
        observedAt: Date.now(),
      }]]),
    });

    renderChannel(true);

    expect(screen.getByTestId('voice-channel-timer')).not.toHaveClass('group-hover:opacity-0');
    expect(screen.getByTestId('voice-channel-settings')).toHaveClass(
      'absolute',
      'right-full',
      'mr-1',
      'pointer-events-none',
      'group-hover:pointer-events-auto',
    );
  });

  it('opens channel settings without also activating the channel row', () => {
    const onSettingsClick = vi.fn();
    const onClick = vi.fn();
    render(
      <VoiceChannel
        channelId="voice-1"
        channelName="Voice"
        onClick={onClick}
        canManage
        onSettingsClick={onSettingsClick}
      />,
    );

    fireEvent.click(screen.getByTestId('voice-channel-settings'));

    expect(onSettingsClick).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the ticking duration out of the accessible name of the channel row', () => {
    useVoiceStore.setState({
      voiceChannelElapsedSeconds: new Map([['voice-1', {
        elapsedSeconds: 65,
        observedAt: Date.now(),
      }]]),
    });

    renderChannel(true);

    expect(screen.getByTestId('voice-channel-timer')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Voice' })).toBeInTheDocument();
  });
});
