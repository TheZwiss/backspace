import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MobileChatScreen } from './MobileChatScreen';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { wsSend } from '../../hooks/useWebSocket';
import type { DmChannel, User } from '@backspace/shared';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn() } }));
vi.mock('../chat/MessageList', () => ({ MessageList: () => null }));
vi.mock('../chat/MessageInput', () => ({ MessageInput: () => null }));
vi.mock('./TransferIndicator', () => ({ TransferIndicator: () => null }));
vi.mock('../../utils/userViewLookup', () => ({ useCanonicalUserView: (user: User) => user }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const partner = { id: 'partner', username: 'alice' } as User;
const dm = { id: 'dm-1', members: [partner], ownerId: null } as DmChannel;
const params = { channelId: dm.id, spaceId: '@me' };

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 'self', username: 'self' } as User });
  useSpaceStore.setState({ dmChannels: [dm], channels: [] });
  useSpaceStore.setState({ channelOriginMap: new Map([[dm.id, 'https://remote.example']]) });
  useChatStore.setState({ loadMessages: vi.fn() });
  useVoiceStore.setState({ outgoingCall: null, activeDmCall: null, incomingCall: null, federatedCallId: null, callOrigin: null });
});

describe('mobile DM calls', () => {
  it.each(['', 'https://remote.example'])('starts and cancels a call on origin %j', (origin) => {
    useSpaceStore.setState({ channelOriginMap: new Map([[dm.id, origin]]) });
    render(<MobileChatScreen params={params} />);
    fireEvent.click(screen.getByRole('button', { name: 'spaces:main.dm.startVoiceCall' }));
    expect(useVoiceStore.getState().outgoingCall).toEqual({ dmChannelId: dm.id });
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_start', dmChannelId: dm.id }, origin);
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.cancel' }));
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).toHaveBeenLastCalledWith({ type: 'dm_call_end', dmChannelId: dm.id, federatedCallId: null }, origin);
  });

  it('routes cancellation to the federated call origin', () => {
    useVoiceStore.setState({ outgoingCall: { dmChannelId: dm.id }, federatedCallId: 'remote-call', callOrigin: 'https://call-host.example' });
    render(<MobileChatScreen params={params} />);
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.cancel' }));
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_end', dmChannelId: dm.id, federatedCallId: 'remote-call' }, 'https://call-host.example');
  });

  it('prevents another call while one is active, outgoing or incoming', () => {
    render(<MobileChatScreen params={params} />);
    for (const state of [
      { activeDmCall: { dmChannelId: 'other' } },
      { outgoingCall: { dmChannelId: 'other' } },
      { incomingCall: { dmChannelId: 'other', callerId: 'other', callerName: 'Other' } },
    ]) {
      act(() => useVoiceStore.setState({ outgoingCall: null, activeDmCall: null, incomingCall: null, ...state }));
      const button = screen.getByRole('button', { name: 'spaces:main.dm.startVoiceCall' });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(wsSend).not.toHaveBeenCalled();
  });

  it('does not offer calls in space channels or deleted-partner DMs', () => {
    const { rerender } = render(<MobileChatScreen params={{ ...params, spaceId: 'space' }} />);
    expect(screen.queryByRole('button', { name: 'spaces:main.dm.startVoiceCall' })).toBeNull();
    act(() => useSpaceStore.setState({ dmChannels: [{ ...dm, members: [{ ...partner, isDeleted: true }] }] }));
    rerender(<MobileChatScreen params={params} />);
    expect(screen.queryByRole('button', { name: 'spaces:main.dm.startVoiceCall' })).toBeNull();
  });
});
