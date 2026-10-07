import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
// The DM header is under test; the message surfaces have their own tests.
vi.mock('../chat/MessageList', () => ({ MessageList: () => null }));
vi.mock('../chat/MessageInput', () => ({ MessageInput: () => null }));

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DmChannel, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { MainContent } from './MainContent';

const partner = { id: 'partner', username: 'alice' } as User;
const dm = { id: 'dm-1', members: [partner], ownerId: null } as DmChannel;

function renderDm() {
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
  useUIStore.setState({ showDms: true });
  useVoiceStore.setState({ outgoingCall: null, activeDmCall: null, incomingCall: null, federatedCallId: null, callOrigin: null });
});

describe('desktop DM header call actions', () => {
  it('starts a call on the DM channel origin', () => {
    useSpaceStore.setState({ channelOriginMap: new Map([[dm.id, 'https://remote.example']]) });
    renderDm();
    fireEvent.click(screen.getByTitle('Start Voice Call'));
    expect(useVoiceStore.getState().outgoingCall).toEqual({ dmChannelId: dm.id });
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_start', dmChannelId: dm.id }, 'https://remote.example');
  });

  it('cannot start a second call while an incoming call rings', () => {
    useVoiceStore.setState({ incomingCall: { dmChannelId: 'other', callerId: 'bob', callerName: 'Bob' } });
    renderDm();
    const button = screen.getByTitle('Start Voice Call');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(wsSend).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
  });

  it('cancels a ringing call through the federated call origin', () => {
    useVoiceStore.setState({
      outgoingCall: { dmChannelId: dm.id },
      federatedCallId: 'remote-call',
      callOrigin: 'https://call-host.example',
    });
    renderDm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).toHaveBeenCalledWith(
      { type: 'dm_call_end', dmChannelId: dm.id, federatedCallId: 'remote-call' },
      'https://call-host.example',
    );
  });
});
