import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeybindStore } from '../stores/keybindStore';
import { useKeybinds } from './useKeybinds';

const mock = vi.hoisted(() => ({
  voice: { currentVoiceChannelId: 'voice', spaceMutedUserIds: new Set(), spaceDeafenedUserIds: new Set(),
    setMuted: vi.fn(), setPttActive: vi.fn(), pttActive: false },
  mute: vi.fn(),
}));
vi.mock('../stores/voiceStore', () => ({ useVoiceStore: Object.assign(
  (selector: (state: typeof mock.voice) => unknown) => selector(mock.voice), { getState: () => mock.voice },
) }));
vi.mock('../stores/spaceStore', () => ({
  getChannelOrigin: () => 'local', getMyUserIdForOrigin: () => 'me',
  useSpaceStore: { getState: () => ({ channelToSpaceMap: new Map() }) },
}));
vi.mock('../utils/voice', () => ({ broadcastVoiceStatus: vi.fn() }));
vi.mock('../utils/voiceActions', () => ({
  handleMuteAction: mock.mute, handleDeafenAction: vi.fn(), handleCameraAction: vi.fn(),
  handleScreenShareAction: vi.fn(), handleDisconnectAction: vi.fn(),
}));
vi.mock('../platform/platform', () => ({ isElectron: () => !!window.backspace }));

function hash(code: string) {
  let value = 5381;
  for (const char of code) value = ((value << 5) + value + char.charCodeAt(0)) | 0;
  return value >>> 0;
}
const binding = { actionId: 'pushToTalk', keys: [hash('KeyV')], displayLabel: 'V' };
let actionListener: (event: { actionId: string; pressed: boolean }) => void;
let statusListener: (status: KeybindPortalStatus) => void;
const sync = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useKeybindStore.setState({ keybinds: [binding] });
  window.backspace = {
    syncKeybinds: sync,
    onKeybindAction: (listener) => { actionListener = listener; return vi.fn(); },
    getKeybindPortalStatus: async () => null,
    onKeybindPortalStatus: (listener) => { statusListener = listener; return vi.fn(); },
  } as unknown as BackspaceElectronAPI;
});
afterEach(() => { cleanup(); delete window.backspace; });

describe('global shortcut renderer bridge', () => {
  it('syncs an empty configuration after deleting the last binding and on unmount', () => {
    const { unmount } = renderHook(() => useKeybinds());
    expect(sync).toHaveBeenLastCalledWith([{ actionId: 'pushToTalk', keys: binding.keys, mouseButton: undefined }]);
    act(() => useKeybindStore.setState({ keybinds: [] }));
    expect(sync).toHaveBeenLastCalledWith([]);
    unmount();
    expect(sync).toHaveBeenLastCalledWith([]);
  });
  it('uses only portal events for an accepted binding and preserves fast PTT cycles', () => {
    renderHook(() => useKeybinds());
    act(() => statusListener({ state: 'ready', shortcuts: { pushToTalk: 'V' } }));
    mock.voice.setMuted.mockClear();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV', key: 'v' }));
    });
    expect(mock.voice.setMuted).not.toHaveBeenCalled();
    act(() => {
      for (const pressed of [true, false, true, false]) actionListener({ actionId: 'pushToTalk', pressed });
    });
    expect(mock.voice.setMuted.mock.calls).toEqual([[false], [true], [false], [true]]);
  });
  it('does not use stale local bindings when the Wayland portal is unavailable', () => {
    renderHook(() => useKeybinds());
    act(() => statusListener({ state: 'unavailable', shortcuts: {} }));
    mock.voice.setMuted.mockClear();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v' }));
      window.dispatchEvent(new Event('blur'));
    });
    expect(mock.voice.setMuted).not.toHaveBeenCalled();
  });
  it('activates PTT from system assignments without a local binding', () => {
    useKeybindStore.setState({ keybinds: [] });
    renderHook(() => useKeybinds());
    act(() => statusListener({ state: 'ready', shortcuts: { pushToTalk: 'F9' } }));
    expect(mock.voice.setPttActive).toHaveBeenLastCalledWith(true);
    expect(mock.voice.setMuted).toHaveBeenLastCalledWith(true);
    act(() => actionListener({ actionId: 'pushToTalk', pressed: true }));
    mock.voice.setMuted.mockClear();
    act(() => statusListener({ state: 'ready', shortcuts: { pushToTalk: 'F9', toggleMute: 'F8' } }));
    expect(mock.voice.setMuted).not.toHaveBeenCalled();
    mock.voice.pttActive = true;
    act(() => statusListener({ state: 'ready', shortcuts: {} }));
    expect(mock.voice.setPttActive).toHaveBeenLastCalledWith(false);
    mock.voice.pttActive = false;
  });
  it('preserves local bindings in a browser and releases held PTT on blur', () => {
    delete window.backspace;
    renderHook(() => useKeybinds());
    mock.voice.setMuted.mockClear();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v' }));
      window.dispatchEvent(new Event('blur'));
    });
    expect(mock.voice.setMuted.mock.calls).toEqual([[false], [true]]);
  });
});
