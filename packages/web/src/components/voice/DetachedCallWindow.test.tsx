import { act, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { DetachedCallWindow, openDetachedCallWindow } from './DetachedCallWindow';

vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('./VoiceGrid', () => ({ VoiceGrid: ({ fullscreen }: { fullscreen: boolean }) => <div>Call video {fullscreen ? 'fullscreen' : 'windowed'}</div> }));
vi.mock('./VoiceControlBar', () => ({ VoiceControlBar: ({ onDetachedFullscreenToggle }: { onDetachedFullscreenToggle: () => void }) => <button onClick={onDetachedFullscreenToggle}>Call controls</button> }));

afterEach(() => { delete window.backspace; vi.restoreAllMocks(); useUIStore.getState().setCallWindowOpen(false); });

describe('detached call window', () => {
  it('renders the call into the child and closes it when the call ends', () => {
    const doc = document.implementation.createHTMLDocument('test');
    const child = Object.assign(new EventTarget(), { document: doc, closed: false, focus: vi.fn(), close: vi.fn() });
    vi.spyOn(window, 'open').mockReturnValue(child as unknown as Window);
    useVoiceStore.setState({ currentVoiceChannelId: 'voice-test', activeDmCall: null });
    expect(openDetachedCallWindow()).toBe(true);
    const mounted = render(<DetachedCallWindow />);
    expect(within(doc.body).getByText('Call video windowed')).toBeTruthy();
    expect(within(doc.body).getByText('Call controls')).toBeTruthy();
    act(() => useVoiceStore.setState({ currentVoiceChannelId: null }));
    expect(child.close).toHaveBeenCalledOnce();
    act(() => child.dispatchEvent(new Event('beforeunload')));
    expect(useUIStore.getState().callWindowOpen).toBe(false);
    mounted.unmount();
  });
  it('toggles fullscreen on the child document without changing the main call state', async () => {
    const doc = document.implementation.createHTMLDocument('test');
    const child = Object.assign(new EventTarget(), { document: doc, closed: false, focus: vi.fn(), close: vi.fn() });
    vi.spyOn(window, 'open').mockReturnValue(child as unknown as Window);
    useVoiceStore.setState({ currentVoiceChannelId: 'voice-test', activeDmCall: null });
    expect(openDetachedCallWindow()).toBe(true);
    const mounted = render(<DetachedCallWindow />);
    let fullscreenElement: Element | null = null;
    Object.defineProperty(doc, 'fullscreenElement', { get: () => fullscreenElement });
    const container = doc.body.firstElementChild as HTMLElement;
    container.requestFullscreen = vi.fn(async () => { fullscreenElement = container; doc.dispatchEvent(new Event('fullscreenchange')); });
    doc.exitFullscreen = vi.fn(async () => { fullscreenElement = null; doc.dispatchEvent(new Event('fullscreenchange')); });
    await act(async () => within(doc.body).getByText('Call controls').click());
    expect(within(doc.body).getByText('Call video fullscreen')).toBeTruthy();
    expect(useUIStore.getState().voiceFullscreen).toBe(false);
    await act(async () => within(doc.body).getByText('Call controls').click());
    expect(within(doc.body).getByText('Call video windowed')).toBeTruthy();
    mounted.unmount();
  });
  it('sends titlebar actions to the detached window', () => {
    const doc = document.implementation.createHTMLDocument('test');
    const child = Object.assign(new EventTarget(), { document: doc, closed: false, focus: vi.fn(), close: vi.fn() });
    const controlCallWindow = vi.fn();
    window.backspace = { platform: 'linux', controlCallWindow } as unknown as BackspaceElectronAPI;
    vi.spyOn(window, 'open').mockReturnValue(child as unknown as Window);
    useVoiceStore.setState({ currentVoiceChannelId: 'voice-test', activeDmCall: null });
    expect(openDetachedCallWindow()).toBe(true);
    const mounted = render(<DetachedCallWindow />);
    act(() => { within(doc.body).getByLabelText('Minimize').click(); within(doc.body).getByLabelText('Maximize or restore').click(); within(doc.body).getByLabelText('Close').click(); });
    expect(controlCallWindow.mock.calls).toEqual([['minimize'], ['maximize'], ['close']]);
    mounted.unmount();
  });
  it('handles a blocked popup without claiming it opened', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openDetachedCallWindow()).toBe(false);
    expect(useUIStore.getState().callWindowOpen).toBe(false);
  });
});
