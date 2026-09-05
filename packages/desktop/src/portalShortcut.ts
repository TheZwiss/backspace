export interface KeybindConfig {
  actionId: string;
  keys: number[];
  mouseButton?: number;
}

export interface PortalKeybindStatus {
  state: 'idle' | 'pending' | 'ready' | 'unavailable';
  shortcuts: Record<string, string>;
}

export function hashCode(code: string): number {
  let hash = 5381;
  for (const char of code) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
  return hash >>> 0;
}

const symbols: Record<string, string> = {
  Backspace: 'BackSpace', Tab: 'Tab', Enter: 'Return', Escape: 'Escape', Space: 'space',
  PageUp: 'Prior', PageDown: 'Next', End: 'End', Home: 'Home',
  ArrowLeft: 'Left', ArrowUp: 'Up', ArrowRight: 'Right', ArrowDown: 'Down',
  Insert: 'Insert', Delete: 'Delete', Semicolon: 'semicolon', Equal: 'equal',
  Comma: 'comma', Minus: 'minus', Period: 'period', Slash: 'slash',
  Backquote: 'grave', BracketLeft: 'bracketleft', Backslash: 'backslash',
  BracketRight: 'bracketright', Quote: 'apostrophe',
  NumpadMultiply: 'KP_Multiply', NumpadAdd: 'KP_Add', NumpadSubtract: 'KP_Subtract',
  NumpadDecimal: 'KP_Decimal', NumpadDivide: 'KP_Divide', NumpadEnter: 'KP_Enter',
  CapsLock: 'Caps_Lock', NumLock: 'Num_Lock', ScrollLock: 'Scroll_Lock', PrintScreen: 'Print',
};
for (let n = 0; n < 26; n++) symbols[`Key${String.fromCharCode(65 + n)}`] = String.fromCharCode(97 + n);
for (let n = 0; n < 10; n++) {
  symbols[`Digit${n}`] = String(n);
  symbols[`Numpad${n}`] = `KP_${n}`;
}
for (let n = 1; n <= 24; n++) symbols[`F${n}`] = `F${n}`;
const keys = new Map(Object.entries(symbols).map(([code, symbol]) => [hashCode(code), symbol]));
const modifiers = new Map<number, string>();
for (const [prefix, modifier] of [['Control', 'CTRL'], ['Alt', 'ALT'], ['Shift', 'SHIFT'], ['Meta', 'LOGO']] as const) {
  for (const side of ['Left', 'Right']) modifiers.set(hashCode(prefix + side), modifier);
}

/** Portal shortcuts are keysyms, not physical scan codes. The compositor has final say. */
export function preferredTrigger(binding: KeybindConfig): string | undefined {
  if (binding.mouseButton !== undefined) return undefined;
  const mods = new Set<string>();
  const normal: string[] = [];
  for (const key of new Set(binding.keys)) {
    const modifier = modifiers.get(key);
    if (modifier) mods.add(modifier);
    else {
      const symbol = keys.get(key);
      if (!symbol) return undefined;
      normal.push(symbol);
    }
  }
  if (normal.length !== 1) return undefined;
  return [...['CTRL', 'ALT', 'SHIFT', 'LOGO'].filter((mod) => mods.has(mod)), normal[0]].join('+');
}

export function isWayland(platform = process.platform, env = process.env): boolean {
  return platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY);
}
