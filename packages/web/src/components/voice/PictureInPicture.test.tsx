import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PictureInPicture } from './PictureInPicture';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import type { DmChannel } from '@backspace/shared';

// AudioManager loads an AudioWorklet module that jsdom cannot evaluate.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

function renderPip() {
  return render(
    <MemoryRouter>
      <PictureInPicture />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // In a space voice channel while looking at a text channel elsewhere: the
  // state in which the floating window appears.
  useVoiceStore.setState({
    currentVoiceChannelId: 'voice-1',
    activeDmCall: null,
    participants: [],
    focusedParticipantId: null,
    watchingStreams: new Set(),
    speakingParticipantIds: new Set(),
    pipEnabled: true,
  });
  useChatStore.setState({ currentChannelId: 'text-1' });
  useUIStore.setState({ voiceFullscreen: false, pipCollapsed: false });
});

afterEach(() => {
  cleanup();
  useVoiceStore.setState({ currentVoiceChannelId: null, activeDmCall: null, pipEnabled: true });
  useChatStore.setState({ currentChannelId: null });
});

describe('PictureInPicture and the floating window setting', () => {
  it('shows while in voice and viewing another channel when the setting is on', () => {
    const { container } = renderPip();
    expect(container).not.toBeEmptyDOMElement();
  });

  it('renders nothing in the same state when the setting is off', () => {
    useVoiceStore.setState({ pipEnabled: false });
    const { container } = renderPip();
    expect(container).toBeEmptyDOMElement();
  });

  it('follows the setting during a DM call viewed from elsewhere', () => {
    useVoiceStore.setState({ currentVoiceChannelId: null, activeDmCall: { dmChannelId: 'dm-1', federatedCallId: null, callOrigin: null, livekit: null } });
    const shown = renderPip();
    expect(shown.container).not.toBeEmptyDOMElement();
    cleanup();

    useVoiceStore.setState({ pipEnabled: false });
    const hidden = renderPip();
    expect(hidden.container).toBeEmptyDOMElement();
  });

  it('reads a call held by its key as the conversation this client has, never as a DM id', () => {
    useSpaceStore.setState({ dmChannels: [{ id: 'dm-copy', federatedId: 'key-1', members: [] } as unknown as DmChannel] });
    useVoiceStore.setState({
      currentVoiceChannelId: null,
      activeDmCall: { dmChannelId: null, federatedCallId: 'key-1', callOrigin: 'https://peer.example', livekit: null },
    });

    // Viewing the call's conversation: no floating window.
    useChatStore.setState({ currentChannelId: 'dm-copy' });
    expect(renderPip().container).toBeEmptyDOMElement();
    cleanup();

    // Viewing the key as if it were a conversation is viewing something else.
    useChatStore.setState({ currentChannelId: 'key-1' });
    expect(renderPip().container).not.toBeEmptyDOMElement();
  });
});
