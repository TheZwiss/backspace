import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
// jsdom has no AudioWorkletNode; the store's imports reach the voice stack.
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

import { IncomingCallModal } from './IncomingCallModal';
import { wsSend } from '../../hooks/useWebSocket';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { initI18n } from '../../i18n';
import i18n from '../../i18n';

const HOST = 'https://host.example';

beforeEach(async () => {
  await initI18n();
  vi.clearAllMocks();
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
  useVoiceStore.setState({
    incomingCall: { dmChannelId: null, callerId: 'caller', callerName: 'Caller' },
    outgoingCall: null,
    activeDmCall: null,
    federatedCallId: 'fed-1',
    federatedCallToken: 'tok',
    federatedCallUrl: 'wss://host.example/lk',
    callOrigin: HOST,
  });
});

describe('IncomingCallModal decline', () => {
  it('declines through the ring\'s origin and forgets the ring\'s call data', () => {
    render(<IncomingCallModal />);

    fireEvent.click(screen.getByTitle(i18n.t('common:actions.decline')));

    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_call_reject', dmChannelId: null, federatedCallId: 'fed-1' }, HOST);
    const state = useVoiceStore.getState();
    expect(state.incomingCall).toBeNull();
    expect(state.federatedCallId).toBeNull();
    expect(state.callOrigin).toBeNull();
  });

  it('keeps the call data while the client is in another call', () => {
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'dm-other' } });
    render(<IncomingCallModal />);

    fireEvent.click(screen.getByTitle(i18n.t('common:actions.decline')));

    expect(useVoiceStore.getState().federatedCallId).toBe('fed-1');
  });
});
