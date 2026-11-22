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

function participant(identity: string, isLocal: boolean) {
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
  } as any;
}

beforeEach(() => {
  useVoiceStore.setState({
    focusedParticipantId: 'ada',
    currentVoiceChannelId: 'voice-1',
    isDeafened: false,
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

  it('uses edge-to-edge layout and floats the members toggle cleanly above the control bar in fullscreen', async () => {
    const { rerender } = render(
      <VoiceGrid
        participants={[participant('ada', true), participant('bob', false)]}
        fullscreen
        chromeRevealed={false}
      />,
    );

    const focusedContainer = screen.getByTestId('focused-tile-container');
    expect(focusedContainer.className).toContain('p-0');
    expect(focusedContainer.className).not.toContain('p-2');
    expect(focusedContainer).not.toHaveAttribute('title');

    // Entering fullscreen defaults the member strip to hidden and auto-hides the toggle when chrome is idle
    const overlay = screen.getByTestId('fullscreen-members-overlay');
    expect(overlay.className).toContain('bottom-24');
    expect(overlay.className).toContain('opacity-0');
    expect(screen.getByText(/show members/i)).toBeInTheDocument();

    // Pointer movement reveals the floating toggle
    rerender(
      <VoiceGrid
        participants={[participant('ada', true), participant('bob', false)]}
        fullscreen
        chromeRevealed
      />,
    );
    expect(screen.getByTestId('fullscreen-members-overlay').className).toContain('opacity-100');

    // Expanding the strip moves it into normal flex flow so the video shrinks cleanly above it
    await userEvent.click(screen.getByText(/show members/i));
    expect(screen.getByText(/hide members/i)).toBeInTheDocument();
    expect(screen.queryByTestId('fullscreen-members-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('members-toggle-bar')).toBeInTheDocument();
    expect(screen.getByTestId('members-strip')).toBeInTheDocument();

    // Collapsing again restores the floating pill above VoiceControlBar
    await userEvent.click(screen.getByText(/hide members/i));
    expect(screen.getByText(/show members/i)).toBeInTheDocument();
    expect(screen.getByTestId('fullscreen-members-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('members-strip')).not.toBeInTheDocument();
  });
});
