import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoiceGrid } from './VoiceGrid';
import { VoiceControlBar } from './VoiceControlBar';
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

    // Grid button clears the h-12 fullscreen voice header overlay and uses focus-within reveal
    const gridBtn = screen.getByRole('button', { name: /grid/i });
    expect(gridBtn.className).toContain('top-14');
    expect(gridBtn.className).toContain('z-30');
    expect(gridBtn.className).toContain('focus-within:opacity-100');

    // Entering fullscreen defaults the member strip to hidden and auto-hides the toggle when chrome is idle
    const overlay = screen.getByTestId('fullscreen-members-overlay');
    expect(overlay.className).toContain('bottom-24');
    expect(overlay.className).toContain('opacity-0');
    expect(overlay.className).toContain('focus-within:opacity-100');
    expect(overlay.className).toContain('focus-within:pointer-events-auto');
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

    // Expanding the strip moves it into normal flex flow above the floating
    // VoiceControlBar band (`mb-24`) and preserves focus on the toggle button
    const toggleBtn = screen.getByRole('button', { name: /show members/i });
    toggleBtn.focus();
    expect(document.activeElement).toBe(toggleBtn);

    await userEvent.click(toggleBtn);
    expect(screen.getByText(/hide members/i)).toBeInTheDocument();
    expect(screen.queryByTestId('fullscreen-members-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('members-toggle-bar')).toBeInTheDocument();
    const strip = screen.getByTestId('members-strip');
    expect(strip).toBeInTheDocument();
    expect(strip.className).toContain('mb-24');
    expect(document.activeElement).toBe(toggleBtn);

    // Collapsing again restores the floating pill above VoiceControlBar while keeping focus
    await userEvent.click(toggleBtn);
    expect(screen.getByText(/show members/i)).toBeInTheDocument();
    expect(screen.getByTestId('fullscreen-members-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('members-strip')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggleBtn);
  });

  it('hides participants without active camera or screen share and keeps watched screen shares visible', () => {
    useVoiceStore.setState({
      focusedParticipantId: null,
      hideNonVideoParticipants: true,
      watchingStreams: new Set(['carol']),
    });
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

  it('clears focus when the focused participant is filtered out and keeps focus on the filter toggle', async () => {
    useVoiceStore.setState({ focusedParticipantId: 'bob', hideNonVideoParticipants: false });
    const participants = [
      participant('ada', true, { isCameraOn: true }),
      participant('bob', false),
    ];

    function Harness() {
      const toggle = useVoiceStore((s) => s.toggleHideNonVideoParticipants);
      const hidden = useVoiceStore((s) => s.hideNonVideoParticipants);
      return (
        <>
          <button type="button" onClick={toggle} aria-pressed={hidden}>
            Toggle non-video
          </button>
          <VoiceGrid participants={participants} />
        </>
      );
    }

    render(<Harness />);
    expect(useVoiceStore.getState().focusedParticipantId).toBe('bob');

    const toggleBtn = screen.getByRole('button', { name: /toggle non-video/i });
    toggleBtn.focus();
    await userEvent.click(toggleBtn);

    // Bob is filtered out, focus is cleared, and keyboard focus stays on the toggle
    expect(useVoiceStore.getState().focusedParticipantId).toBeNull();
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
    expect(screen.getByText('ada')).toBeInTheDocument();
    expect(document.activeElement).toBe(toggleBtn);

    // Disabling the filter does not jump back to the previously cleared focus
    await userEvent.click(toggleBtn);
    expect(useVoiceStore.getState().focusedParticipantId).toBeNull();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(document.activeElement).toBe(toggleBtn);
  });

  it('shows an empty-state fallback and moves focus to the persistent VoiceControlBar filter toggle on Show all participants', async () => {
    useVoiceStore.setState({ focusedParticipantId: null, hideNonVideoParticipants: true });
    render(
      <div>
        <VoiceGrid participants={[participant('ada', true), participant('bob', false)]} />
        <VoiceControlBar revealed />
      </div>,
    );

    // Docked control bar container bounds itself to its parent panel width, not 100vw
    const overlay = screen.getByTestId('voice-control-overlay');
    expect(overlay.className).toContain('max-w-[calc(100%-1rem)]');

    expect(screen.getByText(/no participants with video/i)).toBeInTheDocument();
    const showAllBtn = screen.getByRole('button', { name: /show all participants/i });
    showAllBtn.focus();
    await userEvent.click(showAllBtn);

    expect(useVoiceStore.getState().hideNonVideoParticipants).toBe(false);
    expect(screen.getByText('ada')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    // Focus handed off from the unmounted empty-state button to the persistent filter toggle
    const persistentToggle = screen.getByRole('button', { name: /hide non-video/i });
    expect(document.activeElement).toBe(persistentToggle);
  });
});
