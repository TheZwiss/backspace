import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoiceGrid } from './VoiceGrid';
import { useVoiceStore } from '../../stores/voiceStore';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

vi.mock('../../hooks/useLiveKit', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getActiveRoom: () => null,
    setCameraSubscription: vi.fn(),
    setStreamSubscription: vi.fn(),
  };
});

function participant(identity: string, isLocal: boolean, overrides: Record<string, unknown> = {}) {
  return {
    identity,
    userId: identity,
    username: identity,
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
    ...overrides,
  } as any;
}

beforeEach(() => {
  useVoiceStore.setState({
    focusedParticipantId: 'ada',
    currentVoiceChannelId: 'voice-1',
    isDeafened: false,
    hideNonVideoParticipants: false,
    speakingParticipantIds: new Set(),
    spaceMutedUserIds: new Set(),
    spaceDeafenedUserIds: new Set(),
    permissionMutedUserIds: new Set(),
    unwatchedCameras: new Set(),
    participantMutes: new Map(),
  });
});

describe('VoiceGrid participant strip', () => {
  it('can show the participant strip again after hiding it', async () => {
    render(<VoiceGrid participants={[participant('ada', true), participant('bob', false)]} />);

    await userEvent.click(screen.getByText(/hide members/i));
    expect(screen.getByText(/show members/i)).toBeInTheDocument();

    await userEvent.click(screen.getByText(/show members/i));
    expect(screen.getByText(/hide members/i)).toBeInTheDocument();
  });

  it('hides participants without active camera or screen share when hideNonVideoParticipants is enabled', () => {
    useVoiceStore.setState({ focusedParticipantId: null, hideNonVideoParticipants: true });
    const liveScreenTrack = { readyState: 'live', addEventListener: vi.fn(), removeEventListener: vi.fn(), getSettings: () => ({}) };
    render(
      <VoiceGrid
        participants={[
          participant('ada', true, { isCameraOn: true }),
          participant('bob', false),
          participant('carol', false, { isScreenSharing: true, screenTrack: liveScreenTrack }),
        ]}
      />,
    );

    expect(screen.getByText('ada')).toBeInTheDocument();
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
    expect(screen.getByText(/carol/i)).toBeInTheDocument();
  });

  it('shows an empty-state fallback with a button to show all participants when no one has video', async () => {
    useVoiceStore.setState({ focusedParticipantId: null, hideNonVideoParticipants: true });
    render(<VoiceGrid participants={[participant('ada', true), participant('bob', false)]} />);

    expect(screen.getByText(/no participants with video/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show all participants/i }));

    expect(useVoiceStore.getState().hideNonVideoParticipants).toBe(false);
    expect(screen.getByText('ada')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });
});
