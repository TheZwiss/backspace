import type { SoundShortcut } from '../stores/soundboardStore';
import { useKeybindStore } from '../stores/keybindStore';

export function shortcutFromEvent(event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): SoundShortcut | null {
  if (!event.code || ['Control', 'Shift', 'Alt', 'Meta', 'Escape', 'Tab', 'Enter', 'Backspace', 'Delete'].includes(event.key)) return null;
  return { code: event.code, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey,
    label: [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code.replace(/^Key|^Digit/, '')].filter(Boolean).join(' + ') };
}

export function sameShortcut(a: SoundShortcut, b: SoundShortcut): boolean {
  return a.code === b.code && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;
}

/** Match the existing keybind manager's numeric representation so voice actions never collide. */
export function conflictsWithVoiceShortcut(shortcut: SoundShortcut): boolean {
  const hash = (code: string) => {
    let result = 5381;
    for (const c of code) result = ((result << 5) + result + c.charCodeAt(0)) | 0;
    return result >>> 0;
  };
  const pressed = [shortcut.code];
  if (shortcut.ctrl) pressed.push('ControlLeft', 'ControlRight');
  if (shortcut.alt) pressed.push('AltLeft', 'AltRight');
  if (shortcut.shift) pressed.push('ShiftLeft', 'ShiftRight');
  if (shortcut.meta) pressed.push('MetaLeft', 'MetaRight');
  const keys = new Set(pressed.map(hash));
  return useKeybindStore.getState().keybinds.some(kb => !kb.mouseButton && kb.keys.length > 0 && kb.keys.every(k => keys.has(k)));
}
