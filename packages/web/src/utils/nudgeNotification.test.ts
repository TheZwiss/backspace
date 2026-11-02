import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyNudge } from './nudgeNotification';
import { useNudgePreferences } from '../stores/nudgePreferences';
import { playInAppNudge } from './inAppNudge';
import type { NudgeContext } from './nudgePolicy';

vi.mock('./inAppNudge', () => ({ playInAppNudge: vi.fn() }));
const original = useNudgePreferences.getState();
const descriptor = Object.getOwnPropertyDescriptor(window, 'backspace');
const native = vi.fn();
const getContext = vi.fn();
const context: NudgeContext = { focused: false, minimized: false,
  displays: [{ id: 1, label: 'Primary', primary: true, app: true }, { id: 2, label: 'Secondary', primary: false, app: false }],
  gameRunning: false, foregroundGame: false, gameDisplayIds: [], gameDetectionUncertain: false };
beforeEach(() => {
  vi.clearAllMocks();
  useNudgePreferences.setState(original);
  getContext.mockResolvedValue(context);
  Object.defineProperty(window, 'backspace', { configurable: true, value: { getNudgeContext: getContext, playNudge: native } });
});
afterEach(() => {
  useNudgePreferences.setState(original);
  if (descriptor) Object.defineProperty(window, 'backspace', descriptor); else Reflect.deleteProperty(window, 'backspace');
});
describe('nudge delivery obeys recipient preferences', () => {
  it('does not query games or start any effect when disabled', async () => {
    useNudgePreferences.setState({ scope: 'off' });
    await notifyNudge('Alice', null, '', '123');
    expect(getContext).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(playInAppNudge).not.toHaveBeenCalled();
  });
  it('never invokes a desktop overlay for app-only calls', async () => {
    useNudgePreferences.setState({ scope: 'app' });
    await notifyNudge('Alice', null, '', '123', 'knock');
    expect(native).not.toHaveBeenCalled();
    expect(playInAppNudge).toHaveBeenCalledWith('Alice', undefined, '123', 'knock', expect.objectContaining({ destination: 'app' }));
  });
  it('passes only free monitors and the sound preference to Electron', async () => {
    useNudgePreferences.setState({ scope: 'desktop', gameDetection: 'on', gameAction: 'other-displays', sound: false, volume: 30 });
    getContext.mockResolvedValue({ ...context, gameRunning: true, foregroundGame: true, gameDisplayIds: [1] });
    await notifyNudge('Alice', null, '', '123', 'msn_fart_guy');
    expect(native).toHaveBeenCalledWith('Alice', undefined, '123', expect.objectContaining({ displayIds: [2], sound: false, volume: .3, effect: 'msn_fart_guy' }));
  });
  it('does not leak a desktop-only call into the focused app', async () => {
    useNudgePreferences.setState({ scope: 'desktop' }); getContext.mockResolvedValue({ ...context, focused: true });
    await notifyNudge('Alice', null, '', '123');
    expect(native).not.toHaveBeenCalled(); expect(playInAppNudge).not.toHaveBeenCalled();
  });
});
