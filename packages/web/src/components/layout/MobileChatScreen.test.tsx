import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MobileChatScreen } from './MobileChatScreen';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { wsSend } from '../../hooks/useWebSocket';
import type { DmChannel, User } from '@backspace/shared';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn(() => ({
      clearInputDenial: vi.fn(),
      resumeContext: vi.fn(() => Promise.resolve()),
      setInputDevice: vi.fn(() => Promise.resolve(null)),
    })),
  },
}));
vi.mock('../chat/MessageList', () => ({ MessageList: () => null }));
vi.mock('../chat/MessageInput', () => ({ MessageInput: () => null }));
vi.mock('./TransferIndicator', () => ({ TransferIndicator: () => null }));
vi.mock('../../utils/userViewLookup', () => ({ useCanonicalUserView: (user: User) => user }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const START = 'spaces:main.dm.startVoiceCall';
const CANCEL = 'mobile:chat.cancelCall';
const OPEN = 'mobile:chat.openCall';
const JOIN = 'spaces:main.dm.joinCall';

const partner = { id: 'partner', username: 'alice' } as User;
const dm = { id: 'dm-1', members: [partner], ownerId: null } as DmChannel;
const groupDm = {
  id: 'group-1',
  members: [partner, { id: 'bob', username: 'bob' } as User],
  ownerId: 'self',
} as DmChannel;
const params = { channelId: dm.id, spaceId: '@me' };

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 'self', username: 'self' } as User });
  useSpaceStore.setState({ dmChannels: [dm, groupDm], channels: [] });
  useSpaceStore.setState({ channelOriginMap: new Map([[dm.id, 'https://remote.example']]) });
  useChatStore.setState({ loadMessages: vi.fn() });
  useUIStore.setState({ mobileStack: [] });
  useVoiceStore.setState({ outgoingCall: null, activeDmCall: null, incomingCall: null, voiceUsers: new Map(), connectFn: null });
});

describe('mobile DM calls', () => {
  it.each([
    ['a 1:1 DM', dm.id],
    ['a group DM', groupDm.id],
  ])('offers an enabled call button in %s', (_label, channelId) => {
    render(<MobileChatScreen params={{ channelId, spaceId: '@me' }} />);
    expect(screen.getByRole('button', { name: START })).toBeEnabled();
  });

  it.each(['', 'https://remote.example'])('starts and cancels a call on origin %j', (origin) => {
    useSpaceStore.setState({ channelOriginMap: new Map([[dm.id, origin]]) });
    render(<MobileChatScreen params={params} />);
    fireEvent.click(screen.getByRole('button', { name: START }));
    expect(useVoiceStore.getState().outgoingCall).toEqual({ dmChannelId: dm.id, withCamera: false });
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_start', dmChannelId: dm.id }, origin);
    fireEvent.click(screen.getByRole('button', { name: CANCEL }));
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).toHaveBeenLastCalledWith({ type: 'dm_call_end', dmChannelId: dm.id, federatedCallId: null }, origin);
  });

  it('routes cancellation to the DM origin, whatever a ring that arrived meanwhile names', () => {
    useSpaceStore.setState({ channelOriginMap: new Map([[dm.id, 'https://call-host.example']]) });
    useVoiceStore.setState({
      outgoingCall: { dmChannelId: dm.id, withCamera: false },
      incomingCall: { dmChannelId: null, federatedCallId: 'remote-call', callOrigin: 'https://elsewhere.example', callerId: 'c', callerName: 'C', livekit: null },
    });
    render(<MobileChatScreen params={params} />);
    fireEvent.click(screen.getByRole('button', { name: CANCEL }));
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_end', dmChannelId: dm.id, federatedCallId: null }, 'https://call-host.example');
  });

  it('prevents another call while one is active, outgoing or incoming elsewhere', () => {
    render(<MobileChatScreen params={params} />);
    for (const state of [
      { activeDmCall: { dmChannelId: 'other', federatedCallId: null, callOrigin: null, livekit: null } },
      { outgoingCall: { dmChannelId: 'other', withCamera: false } },
      { incomingCall: { dmChannelId: 'other', federatedCallId: null, callOrigin: null, callerId: 'other', callerName: 'Other', livekit: null } },
    ]) {
      act(() => useVoiceStore.setState({ outgoingCall: null, activeDmCall: null, incomingCall: null, ...state }));
      const button = screen.getByRole('button', { name: START });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(wsSend).not.toHaveBeenCalled();
  });

  it('cannot call back over a call ringing in from this DM', () => {
    useVoiceStore.setState({ incomingCall: { dmChannelId: dm.id, federatedCallId: null, callOrigin: null, callerId: partner.id, callerName: 'alice', livekit: null } });
    render(<MobileChatScreen params={params} />);
    const button = screen.getByRole('button', { name: START });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(wsSend).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
  });

  it('joins the call already running in a group DM instead of starting one', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ voiceUsers: new Map([[groupDm.id, ['partner', 'bob']]]), connectFn });
    render(<MobileChatScreen params={{ channelId: groupDm.id, spaceId: '@me' }} />);
    fireEvent.click(screen.getByRole('button', { name: JOIN }));
    expect(useVoiceStore.getState().activeDmCall).toEqual({ dmChannelId: groupDm.id, federatedCallId: null, callOrigin: null, livekit: null });
    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_accept', dmChannelId: groupDm.id }, '');
    expect(connectFn).toHaveBeenCalledWith(groupDm.id, true);
  });

  it('opens the call screen while in a call with this DM', () => {
    useVoiceStore.setState({ activeDmCall: { dmChannelId: dm.id, federatedCallId: null, callOrigin: null, livekit: null } });
    render(<MobileChatScreen params={params} />);
    expect(screen.queryByRole('button', { name: START })).toBeNull();
    const button = screen.getByRole('button', { name: OPEN });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(useUIStore.getState().mobileStack.at(-1)?.screen).toBe('voice-full');
    expect(wsSend).not.toHaveBeenCalled();
  });

  it('does not offer calls in space channels or deleted-partner DMs', () => {
    const { rerender } = render(<MobileChatScreen params={{ ...params, spaceId: 'space' }} />);
    expect(screen.queryByRole('button', { name: START })).toBeNull();
    act(() => useSpaceStore.setState({ dmChannels: [{ ...dm, members: [{ ...partner, isDeleted: true }] }] }));
    rerender(<MobileChatScreen params={params} />);
    expect(screen.queryByRole('button', { name: START })).toBeNull();
  });
});

describe('mobile chat header labels', () => {
  it('names the back button', () => {
    render(<MobileChatScreen params={params} />);
    expect(screen.getByRole('button', { name: 'common:actions.back' })).toBeInTheDocument();
  });

  it('names the group info and members buttons through the catalogs', () => {
    const { unmount } = render(<MobileChatScreen params={{ channelId: groupDm.id, spaceId: '@me' }} />);
    expect(screen.getByRole('button', { name: 'dm:groupInfo.title' })).toBeInTheDocument();
    unmount();
    useSpaceStore.setState({ channels: [{ id: 'c-1', name: 'general', type: 'text' }] as never });
    render(<MobileChatScreen params={{ channelId: 'c-1', spaceId: 'space' }} />);
    expect(screen.getByRole('button', { name: 'common:labels.members' })).toBeInTheDocument();
  });
});
