import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DmChannel, User } from '@backspace/shared';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ releaseInputStream: vi.fn() }) },
}));

import { MobileVoiceMiniBar } from './MobileVoiceMiniBar';
import { wsSend } from '../../hooks/useWebSocket';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { initI18n } from '../../i18n';
import i18n from '../../i18n';

const dm = {
  id: 'dm-1',
  ownerId: null,
  members: [{ id: 'me', username: 'me' }, { id: 'bob', username: 'bob', displayName: 'Bob' }],
} as unknown as DmChannel;

beforeEach(async () => {
  await initI18n();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 'me', username: 'me' } as User });
  useUIStore.setState({ mobileStack: [] });
  useSpaceStore.setState({ dmChannels: [dm], channels: [], channelOriginMap: new Map() });
  useVoiceStore.setState({
    currentVoiceChannelId: null,
    activeDmCall: { dmChannelId: dm.id, federatedCallId: null, callOrigin: null, livekit: null },
    participants: [{ userId: 'me' }, { userId: 'bob' }] as never,
    voiceUsers: new Map(),
    disconnectFn: null,
  });
});

afterEach(() => {
  cleanup();
  useVoiceStore.setState({ activeDmCall: null, participants: [] });
});

describe('MobileVoiceMiniBar during a DM call', () => {
  it('shows the call, named by its conversation and counted from the room', () => {
    render(<MobileVoiceMiniBar />);
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('spaces:main.voice.participants', { count: 2 }))).toBeInTheDocument();
  });

  it('falls back to the translated label when the conversation is not here', () => {
    useSpaceStore.setState({ dmChannels: [] });
    render(<MobileVoiceMiniBar />);
    expect(screen.getByText(i18n.t('voice:status.dmCall'))).toBeInTheDocument();
  });

  it('hangs the call up through the one hang-up path', () => {
    render(<MobileVoiceMiniBar />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('voice:mobileCall.disconnect') }));
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_end', dmChannelId: dm.id, federatedCallId: null }, '');
    expect(useVoiceStore.getState().activeDmCall).toBeNull();
  });

  it('names a voice channel it cannot find with the translated label', () => {
    useVoiceStore.setState({ activeDmCall: null, currentVoiceChannelId: 'voice-1' });
    render(<MobileVoiceMiniBar />);
    expect(screen.getByText(i18n.t('voice:status.voiceCall'))).toBeInTheDocument();
  });
});

describe('MobileVoiceMiniBar mute and deafen', () => {
  // The other members learn of a mute or deafen from the voice_status this
  // sends, as from the desktop controls.
  it('tells the server when the user mutes', () => {
    useVoiceStore.setState({ isMuted: false, isDeafened: false });
    render(<MobileVoiceMiniBar />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('voice:controls.mute') }));
    expect(useVoiceStore.getState().isMuted).toBe(true);
    expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'voice_status', isMuted: true }), '');
  });

  it('tells the server when the user deafens', () => {
    useVoiceStore.setState({ isMuted: false, isDeafened: false });
    render(<MobileVoiceMiniBar />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('voice:controls.deafen') }));
    expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'voice_status', isDeafened: true }), '');
  });

  it('leaves the mute alone while a moderator holds a space mute', () => {
    useSpaceStore.setState({ channelToSpaceMap: new Map([['voice-1', 'space-1']]) });
    useVoiceStore.setState({
      activeDmCall: null, currentVoiceChannelId: 'voice-1', isMuted: false,
      spaceMutedUserIds: new Set(['space-1:me']),
    });
    useAuthStore.setState({ user: { id: 'me', username: 'me' } as User, myRowIds: new Map([['', 'me']]) });
    render(<MobileVoiceMiniBar />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('voice:controls.mute') }));
    expect(useVoiceStore.getState().isMuted).toBe(false);
    expect(wsSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'voice_status' }), expect.anything());
  });
});
