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
    expect(overlay).toHaveClass(
      'group-hover/voice:opacity-100',
      '[@media(hover:none)]:opacity-100',
      '[@media(any-pointer:coarse)]:opacity-100',
    );
    expect(overlay.firstElementChild).toHaveClass('pointer-events-auto');
  });
});
