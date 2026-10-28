import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
      clearInputDenial: vi.fn(),
      resumeContext: vi.fn(() => Promise.resolve()),
      setInputDevice: vi.fn(() => Promise.resolve(null)),
    }),
  },
}));
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../voice/VoiceGrid', () => ({ VoiceGrid: () => <div data-testid="voice-grid" /> }));
vi.mock('../voice/VoiceChatPanel', () => ({ VoiceChatPanel: () => <div data-testid="voice-chat-panel" /> }));
vi.mock('../voice/VoiceControlBar', () => ({
  VoiceControlBar: ({ variant = 'floating' }: { variant?: 'floating' | 'docked' }) => (
    <div data-testid={`voice-controls-${variant}`} />
  ),
}));

import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DmChannel, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { MainContent } from './MainContent';

const partner = { id: 'partner', username: 'alice' } as User;
const dm = { id: 'dm-1', members: [partner], ownerId: null } as DmChannel;

function renderCall() {
  return render(
    <MemoryRouter initialEntries={[`/channels/@me/${dm.id}`]}>
      <MainContent />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 'self', username: 'self' } as User });
  useChatStore.setState({ currentChannelId: dm.id });
  useSpaceStore.setState({ currentSpaceId: null, channels: [], dmChannels: [dm], channelOriginMap: new Map() });
  useUIStore.setState({ showDms: true, voiceChatOpen: false, voiceChatFocus: false, voiceFullscreen: false });
  useVoiceStore.setState({
    outgoingCall: null,
    incomingCall: null,
    voiceUsers: new Map(),
    connectFn: null,
    currentVoiceChannelId: null,
    activeDmCall: { dmChannelId: dm.id, federatedCallId: null, callOrigin: null, livekit: null },
  });
});

describe('voice chat focus', () => {
  it('shows the tile grid and the floating controls by default', () => {
    renderCall();
    expect(screen.getByTestId('voice-grid')).toBeTruthy();
    expect(screen.getByTestId('voice-controls-floating')).toBeTruthy();
    expect(screen.queryByTestId('voice-chat-panel')).toBeNull();
  });

  it('replaces the grid with the full-width chat and docked controls', () => {
    const { rerender } = renderCall();
    act(() => useUIStore.setState({ voiceChatFocus: true, voiceChatOpen: true }));
    rerender(
      <MemoryRouter initialEntries={[`/channels/@me/${dm.id}`]}>
        <MainContent />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('voice-grid')).toBeNull();
    expect(screen.getByTestId('voice-chat-panel')).toBeTruthy();
    expect(screen.getByTestId('voice-controls-docked')).toBeTruthy();
    expect(screen.queryByTestId('voice-controls-floating')).toBeNull();
  });

  it('resets the focus when the voice connection changes', () => {
    const { rerender } = renderCall();
    act(() => useUIStore.setState({ voiceChatFocus: true, voiceChatOpen: true }));
    expect(useUIStore.getState().voiceChatFocus).toBe(true);

    act(() => useVoiceStore.setState({ currentVoiceChannelId: 'other-channel' }));
    rerender(
      <MemoryRouter initialEntries={[`/channels/@me/${dm.id}`]}>
        <MainContent />
      </MemoryRouter>,
    );
    expect(useUIStore.getState().voiceChatFocus).toBe(false);
  });
});

describe('voiceChatFocus store', () => {
  it('opens the chat when focusing and leaves it as a side panel when unfocusing', () => {
    const store = useUIStore.getState();
    store.setVoiceChatFocus(true);
    expect(useUIStore.getState()).toMatchObject({ voiceChatFocus: true, voiceChatOpen: true });

    store.toggleVoiceChatFocus();
    expect(useUIStore.getState()).toMatchObject({ voiceChatFocus: false, voiceChatOpen: true });
  });

  it('drops the focus when the chat is closed', () => {
    useUIStore.setState({ voiceChatFocus: true, voiceChatOpen: true });
    useUIStore.getState().toggleVoiceChat();
    expect(useUIStore.getState()).toMatchObject({ voiceChatFocus: false, voiceChatOpen: false });
  });
});
