import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
const join = vi.hoisted(() => vi.fn());
vi.mock('../../utils/voiceActions', () => ({ canStartDmCall: () => true, joinDmCall: join }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { remaining?: string }) => args?.remaining ? `Waiting ${args.remaining}` : key }) }));
import { useVoiceStore } from '../../stores/voiceStore';
import { DmCallStatus } from './DmCallStatus';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('private call waiting banner', () => {
  it('shows the deadline, counts down and lets the absent participant return', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000000);
    useVoiceStore.setState({ voiceUsers: new Map([['dm', ['friend']]]), dmWaitingUntil: new Map([['dm', Date.now() + 300000]]), activeDmCall: null });
    render(<DmCallStatus channelId="dm" />);
    expect(screen.getByText('Waiting 5:00')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Waiting 4:59')).toBeTruthy();
    fireEvent.click(screen.getByText('rejoinCall'));
    expect(join).toHaveBeenCalledWith('dm');
    act(() => useVoiceStore.setState({ dmWaitingUntil: new Map(), voiceUsers: new Map([['dm', ['friend', 'me']]]) }));
    expect(screen.getByText('callOngoing')).toBeTruthy();
  });
});
