import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
// jsdom has no AudioWorkletNode; the store's imports reach the voice stack.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: () => ({
      clearInputDenial: vi.fn(),
      resumeContext: vi.fn(() => Promise.resolve()),
      setInputDevice: vi.fn(() => Promise.resolve(null)),
    }),
  },
}));

import { IncomingCallModal } from './IncomingCallModal';
import { wsSend } from '../../hooks/useWebSocket';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { initI18n } from '../../i18n';
import i18n from '../../i18n';

const HOST = 'https://host.example';
const RING = {
  dmChannelId: null, federatedCallId: 'fed-1', callOrigin: HOST,
  callerId: 'caller', callerName: 'Caller', livekit: { token: 'tok', url: 'wss://host.example/lk' },
};

beforeEach(async () => {
  await initI18n();
  vi.clearAllMocks();
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
  useVoiceStore.setState({
    incomingCall: RING,
    outgoingCall: null,
    activeDmCall: null,
    connectFn: null,
  });
});

describe('IncomingCallModal decline', () => {
  it('declines through the ring\'s origin with the ring\'s ids', () => {
    render(<IncomingCallModal />);

    fireEvent.click(screen.getByTitle(i18n.t('common:actions.decline')));

    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_reject', dmChannelId: null, federatedCallId: 'fed-1' }, HOST);
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  it('leaves the call the client is in as it was', () => {
    const held = { dmChannelId: 'dm-other', federatedCallId: null, callOrigin: null, livekit: null };
    useVoiceStore.setState({ activeDmCall: held });
    render(<IncomingCallModal />);

    fireEvent.click(screen.getByTitle(i18n.t('common:actions.decline')));

    expect(useVoiceStore.getState().activeDmCall).toEqual(held);
  });
});

describe('IncomingCallModal accept', () => {
  it('joins under the ring\'s key, never storing it as the DM id, and connects in the tap', () => {
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ connectFn });
    render(<IncomingCallModal />);

    fireEvent.click(screen.getByTitle(i18n.t('common:actions.accept')));

    const active = useVoiceStore.getState().activeDmCall;
    expect(active?.dmChannelId).toBeNull();
    expect(active?.federatedCallId).toBe('fed-1');
    expect(active?.callOrigin).toBe(HOST);
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_accept', dmChannelId: null, federatedCallId: 'fed-1' }, HOST);
    expect(connectFn).toHaveBeenCalledWith('fed-1', true);
  });
});
