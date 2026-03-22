import { describe, it, expect, beforeEach } from 'vitest';
import { useKeybindStore } from './keybindStore';

beforeEach(() => {
  useKeybindStore.setState({ keybinds: [] });
});

describe('keybindStore', () => {
  it('starts with no keybinds', () => {
    expect(useKeybindStore.getState().keybinds).toEqual([]);
  });

  it('adds a keybind', () => {
    useKeybindStore.getState().setKeybind({
      actionId: 'toggleMute',
      keys: [42, 50],
      displayLabel: 'Shift + M',
    });
    const kb = useKeybindStore.getState().keybinds;
    expect(kb).toHaveLength(1);
    expect(kb[0].actionId).toBe('toggleMute');
    expect(kb[0].keys).toEqual([42, 50]); // sorted
  });

  it('sorts keys on save', () => {
    useKeybindStore.getState().setKeybind({
      actionId: 'toggleMute',
      keys: [50, 42],
      displayLabel: 'Shift + M',
    });
    expect(useKeybindStore.getState().keybinds[0].keys).toEqual([42, 50]);
  });

  it('replaces existing keybind for same action', () => {
    const store = useKeybindStore.getState();
    store.setKeybind({ actionId: 'toggleMute', keys: [42], displayLabel: 'Shift' });
    store.setKeybind({ actionId: 'toggleMute', keys: [50], displayLabel: 'M' });
    expect(useKeybindStore.getState().keybinds).toHaveLength(1);
    expect(useKeybindStore.getState().keybinds[0].displayLabel).toBe('M');
  });

  it('removes a keybind', () => {
    useKeybindStore.getState().setKeybind({
      actionId: 'toggleMute',
      keys: [42],
      displayLabel: 'Shift',
    });
    useKeybindStore.getState().removeKeybind('toggleMute');
    expect(useKeybindStore.getState().keybinds).toEqual([]);
  });

  it('detects conflicts', () => {
    useKeybindStore.getState().setKeybind({
      actionId: 'toggleMute',
      keys: [42, 50],
      displayLabel: 'Shift + M',
    });
    const conflict = useKeybindStore.getState().findConflict([42, 50]);
    expect(conflict).not.toBeNull();
    expect(conflict!.actionId).toBe('toggleMute');
  });

  it('excludes specified action from conflict check', () => {
    useKeybindStore.getState().setKeybind({
      actionId: 'toggleMute',
      keys: [42, 50],
      displayLabel: 'Shift + M',
    });
    const conflict = useKeybindStore.getState().findConflict([42, 50], undefined, 'toggleMute');
    expect(conflict).toBeNull();
  });

  it('detects mouse button conflicts', () => {
    useKeybindStore.getState().setKeybind({
      actionId: 'toggleMute',
      keys: [],
      mouseButton: 4,
      displayLabel: 'Mouse 4',
    });
    const conflict = useKeybindStore.getState().findConflict([], 4);
    expect(conflict).not.toBeNull();
  });

  it('rejects blacklisted mouse buttons', () => {
    useKeybindStore.getState().setKeybind({
      actionId: 'toggleMute',
      keys: [],
      mouseButton: 1, // left click — blacklisted
      displayLabel: 'Mouse 1',
    });
    expect(useKeybindStore.getState().keybinds).toEqual([]);
  });

  it('supports modifier + mouse button combos', () => {
    useKeybindStore.getState().setKeybind({
      actionId: 'pushToTalk',
      keys: [42],
      mouseButton: 4,
      displayLabel: 'Shift + Mouse 4',
    });
    const kb = useKeybindStore.getState().keybinds;
    expect(kb).toHaveLength(1);
    expect(kb[0].keys).toEqual([42]);
    expect(kb[0].mouseButton).toBe(4);
  });
});
