import { beforeEach, describe, expect, it } from 'vitest';
import { useKeybindStore } from '../stores/keybindStore';
import { shortcutFromEvent, sameShortcut, conflictsWithVoiceShortcut } from './soundboardShortcuts';

const event = { code: 'KeyK', key: 'k', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
beforeEach(() => useKeybindStore.setState({ keybinds: [] }));
describe('personal sound shortcuts', () => {
  it('captures exact modifiers and physical keys', () => {
    const shortcut = shortcutFromEvent(event)!;
    expect(shortcut.label).toBe('Ctrl + K');
    expect(sameShortcut(shortcut, { ...shortcut, shift: true })).toBe(false);
    expect(shortcutFromEvent({ ...event, key: 'Escape' })).toBeNull();
  });
  it('detects collisions with voice controls, including subset chords and either modifier side', () => {
    const hash = (code: string) => { let h = 5381; for (const c of code) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return h >>> 0; };
    useKeybindStore.setState({ keybinds: [{ actionId: 'toggleMute', keys: [hash('ControlRight'), hash('KeyK')], displayLabel: 'Ctrl + K' }] });
    expect(conflictsWithVoiceShortcut(shortcutFromEvent(event)!)).toBe(true);
    expect(conflictsWithVoiceShortcut(shortcutFromEvent({ ...event, key: 'j', code: 'KeyJ' })!)).toBe(false);
  });
});
