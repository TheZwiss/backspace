import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoiceControlBar } from './VoiceControlBar';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

vi.mock('../../utils/voiceActions', () => ({
  handleMuteAction: vi.fn(),
  handleDeafenAction: vi.fn(),
  handleCameraAction: vi.fn(),
  handleScreenShareAction: vi.fn(),
  handleDisconnectAction: vi.fn(),
}));

vi.mock('./ScreenShareSettingsPopover', () => ({
  ScreenShareSettingsPopover: () => null,
}));

beforeEach(() => {
  useUIStore.setState({ voiceFullscreen: true, voiceChatOpen: false });
  useVoiceStore.setState({
    currentVoiceChannelId: null,
    activeDmCall: { dmChannelId: 'dm-1' },
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
    spaceMutedUserIds: new Set(),
    spaceDeafenedUserIds: new Set(),
  });
});

describe('VoiceControlBar fullscreen hit testing', () => {
  it('does not let the transparent hover zone block controls behind it', () => {
    render(<VoiceControlBar />);

    const overlay = screen.getByTestId('voice-control-overlay');
    expect(overlay).toHaveClass('pointer-events-none', 'h-24');
    expect(overlay.firstElementChild).toHaveClass('pointer-events-auto');
  });

  it('keeps the bar up for pointers that cannot hover', () => {
    render(<VoiceControlBar />);

    expect(screen.getByTestId('voice-control-overlay')).toHaveClass(
      '[@media(hover:none)]:opacity-100',
      '[@media(any-pointer:coarse)]:opacity-100',
    );
  });
});

describe('VoiceControlBar fullscreen visibility', () => {
  // The bar used to be revealed by `group-hover/voice`. In fullscreen that
  // group is the whole viewport, so hover was true wherever the pointer sat
  // and the bar never went away. Visibility is now an idle state passed in.
  it('is hidden while the pointer is idle', () => {
    render(<VoiceControlBar revealed={false} />);

    const overlay = screen.getByTestId('voice-control-overlay');
    expect(overlay).toHaveClass('opacity-0');
    expect(overlay.className).not.toContain('group-hover/voice');
  });

  it('is shown while the pointer is active', () => {
    render(<VoiceControlBar revealed />);

    expect(screen.getByTestId('voice-control-overlay')).toHaveClass('opacity-100');
  });

  it('marks itself as chrome so resting on it does not time out', () => {
    render(<VoiceControlBar revealed />);

    expect(screen.getByTestId('voice-control-overlay')).toHaveAttribute('data-voice-chrome');
  });

  it('ignores the idle state while docked', () => {
    useUIStore.setState({ voiceFullscreen: false });
    render(<VoiceControlBar revealed={false} />);

    // Docked, hover is the right model: the panel has sidebars to leave to.
    expect(screen.getByTestId('voice-control-overlay')).toHaveClass('group-hover/voice:opacity-100');
  });
});
