import data from '@emoji-mart/data';
import type { Emoji, EmojiMartData } from '@emoji-mart/data';

// ─── Emoji shortcodes ───────────────────────────────────────────────────────
// `:name:` text is turned into the emoji it names when user text is rendered.
// The names are the emoji picker's own (emoji-mart's data set, which the picker
// already ships), so any name the picker shows for an emoji works when typed.
// Two spellings are accepted on top of that:
//   - `_` and `-` are the same character, so Discord-style `:flag_va:` finds
//     emoji-mart's `flag-va`. No two names in the set collide under this rule.
//   - a skin tone in the picker's own syntax, `:+1::skin-tone-4:`.
// Names are case sensitive and unknown names stay as typed, so clock times
// (`09:30:00`) and ordinary colons are never touched.
//
// Conversion happens at render time and the stored text is left alone: a bio
// or message keeps the shortcodes it was written with, and every client and
// every federated peer renders it the same way.

const EMOJI_DATA = data as EmojiMartData;

/** A shortcode, optionally followed by a skin tone: `:name:` or `:name::skin-tone-N:`. */
const SHORTCODE_SOURCE = ':([a-z0-9_+-]+):(?::skin-tone-([1-6]):)?';

function normaliseName(name: string): string {
  return name.replace(/-/g, '_');
}

let lookup: Map<string, Emoji> | null = null;

/** Normalised name or alias → emoji. Built on first use. */
function getLookup(): Map<string, Emoji> {
  if (lookup) return lookup;
  const map = new Map<string, Emoji>();
  for (const [id, emoji] of Object.entries(EMOJI_DATA.emojis)) {
    map.set(normaliseName(id), emoji);
  }
  for (const [alias, id] of Object.entries(EMOJI_DATA.aliases)) {
    const emoji = EMOJI_DATA.emojis[id];
    if (emoji) map.set(normaliseName(alias), emoji);
  }
  lookup = map;
  return map;
}

/**
 * Replace every known `:shortcode:` in plain text with its emoji. Anything that
 * is not a known name is returned exactly as written.
 */
export function replaceEmojiShortcodes(text: string): string {
  if (!text.includes(':')) return text;
  const emojis = getLookup();
  const pattern = new RegExp(SHORTCODE_SOURCE, 'g');
  let result = '';
  let copiedUpTo = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const whole = match[0];
    const name = match[1] ?? '';
    const tone = match[2];
    const emoji = emojis.get(normaliseName(name));
    if (!emoji) {
      // Not a name: its closing colon may open the next shortcode
      // (`ratio:10:smile:`), so resume the search from that colon.
      pattern.lastIndex = match.index + name.length + 1;
      continue;
    }

    const base = emoji.skins[0]?.native ?? '';
    const toned = tone ? emoji.skins[Number(tone) - 1]?.native : base;
    result += text.slice(copiedUpTo, match.index);
    // An emoji without skin tones keeps the tone suffix as text rather than
    // silently dropping what was typed.
    result += toned ?? base + whole.slice(name.length + 2);
    copiedUpTo = match.index + whole.length;
  }

  return copiedUpTo === 0 ? text : result + text.slice(copiedUpTo);
}

// ─── Remark plugin ──────────────────────────────────────────────────────────
// Markdown text goes through the same replacement, applied to text nodes only.
// Code spans and fenced blocks are `inlineCode`/`code` nodes, not text, so what
// is written as code stays literal. Link text is skipped too: an autolinked URL
// is shown as its own text and must read exactly like the address it opens.

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

const SKIPPED_PARENTS = new Set(['link', 'linkReference']);

function replaceInTree(node: MdastNode): void {
  if (node.type === 'text' && typeof node.value === 'string') {
    node.value = replaceEmojiShortcodes(node.value);
    return;
  }
  if (!node.children || SKIPPED_PARENTS.has(node.type)) return;
  for (const child of node.children) replaceInTree(child);
}

/** remark plugin: render `:shortcode:` text as emoji. */
export function remarkEmojiShortcodes() {
  return (tree: MdastNode) => {
    replaceInTree(tree);
  };
}
