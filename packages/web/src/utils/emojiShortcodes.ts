import data from '@emoji-mart/data';
import type { Emoji, EmojiMartData } from '@emoji-mart/data';

// ─── Emoji shortcodes ───────────────────────────────────────────────────────
// `:name:` text is turned into the emoji it names when user text is rendered.
// Conversion happens at render time and stored text is never changed, so old
// bios and messages, and text from federated peers, render the same way on
// every client.
//
// Names, in order of precedence:
//   1. the emoji picker's own names (emoji-mart's data set, bundled with the
//      picker), including its aliases;
//   2. Discord's names that emoji-mart does not have (`:cross:`,
//      `:slight_smile:`, `:regional_indicator_a:`), from the generated table in
//      discordEmojiAliases.ts. That table is its own chunk: main.tsx loads it
//      with `loadDiscordEmojiAliases()` before the first render;
//   3. Discord's skin-tone spellings on any name from 1 or 2: `_tone1`..`_tone5`
//      and `_light_skin_tone`.. `_dark_skin_tone` (tone 1 is the lightest).
// In every name `_` and `-` are the same character, so `:flag_va:` finds
// emoji-mart's `flag-va`. The picker's own tone syntax, `:+1::skin-tone-4:`,
// works too. Names are case sensitive.
//
// A shortcode only counts at a word boundary: the character before its first
// colon and the one after its last colon must not be an ASCII letter or digit.
// That keeps `user:id:42`, `2001:db8:a:b::1` and `s[1:-1:2]` as written while
// `est.:cross:`, `:smile::smile:` and CJK text without spaces still convert.
// Text inside a URL (`https://…`, `www.…`) is never converted, and unknown
// names stay as typed.

const EMOJI_DATA = data as EmojiMartData;

/** A shortcode, optionally followed by the picker's skin tone: `:name:` or `:name::skin-tone-N:`. */
const SHORTCODE_SOURCE = ':([a-z0-9_+-]+):(?::skin-tone-([1-6]):)?';
/** A URL as it appears in text; shortcodes inside one are left alone. */
const URL_SOURCE = '\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s<>]*|\\bwww\\.[^\\s<>]*';
const TONE_WORDS = ['light', 'medium_light', 'medium', 'medium_dark', 'dark'] as const;
const DISCORD_TONE = new RegExp(`^(.+?)_(?:tone([1-5])|(${TONE_WORDS.join('|')})_skin_tone)$`);

function normaliseName(name: string): string {
  return name.replace(/-/g, '_');
}

function stripVariation(text: string): string {
  return text.replace(/️/g, '');
}

function isAsciiAlphanumeric(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9]$/.test(char);
}

// ─── Name tables ────────────────────────────────────────────────────────────

let martByName: Map<string, Emoji> | null = null;
let martByNative: Map<string, Emoji> | null = null;

/** Normalised emoji-mart name or alias → emoji. Built on first use. */
function getMartByName(): Map<string, Emoji> {
  if (martByName) return martByName;
  const map = new Map<string, Emoji>();
  for (const [id, emoji] of Object.entries(EMOJI_DATA.emojis)) map.set(normaliseName(id), emoji);
  for (const [alias, id] of Object.entries(EMOJI_DATA.aliases)) {
    const emoji = EMOJI_DATA.emojis[id];
    if (emoji) map.set(normaliseName(alias), emoji);
  }
  martByName = map;
  return map;
}

/** Emoji (without variation selectors) → its emoji-mart entry, for skin tones of Discord names. */
function getMartByNative(): Map<string, Emoji> {
  if (martByNative) return martByNative;
  const map = new Map<string, Emoji>();
  for (const emoji of Object.values(EMOJI_DATA.emojis)) {
    const base = emoji.skins[0]?.native;
    if (base) map.set(stripVariation(base), emoji);
  }
  martByNative = map;
  return map;
}

let discordAliases: Readonly<Record<string, string>> | null = null;
let discordAliasesLoad: Promise<void> | null = null;

/**
 * Load Discord's names (a separate chunk). Resolves once they are available,
 * or once loading has failed: the app renders either way, and without the
 * table only Discord-only names stay as typed.
 */
export function loadDiscordEmojiAliases(): Promise<void> {
  discordAliasesLoad ??= import('./discordEmojiAliases')
    .then((module) => { discordAliases = module.DISCORD_EMOJI_ALIASES; })
    .catch((error: unknown) => { console.warn('[emoji] Discord shortcode names failed to load:', error); });
  return discordAliasesLoad;
}

function discordAlias(name: string): string | undefined {
  return discordAliases && Object.prototype.hasOwnProperty.call(discordAliases, name)
    ? discordAliases[name]
    : undefined;
}

interface Resolved {
  native: string;
  /** The emoji-mart entry, when the name can still take the picker's skin tone. */
  tonable: Emoji | null;
}

/** An untoned name from emoji-mart or Discord's table. */
function resolveBaseName(name: string): Resolved | null {
  const emoji = getMartByName().get(name);
  if (emoji) return { native: emoji.skins[0]?.native ?? '', tonable: emoji };
  const native = discordAlias(name);
  if (native === undefined) return null;
  return { native, tonable: getMartByNative().get(stripVariation(native)) ?? null };
}

function resolveName(rawName: string): Resolved | null {
  const name = normaliseName(rawName);
  const direct = resolveBaseName(name);
  if (direct) return direct;

  const tone = DISCORD_TONE.exec(name);
  if (!tone) return null;
  const base = tone[1] ?? '';
  const level = tone[2] ? Number(tone[2]) : TONE_WORDS.indexOf(tone[3] as (typeof TONE_WORDS)[number]) + 1;
  // The table lists the toned names the general rule below would get wrong.
  const listed = discordAlias(`${base}_tone${level}`);
  if (listed !== undefined) return { native: listed, tonable: null };
  const toned = resolveBaseName(base)?.tonable?.skins[level]?.native;
  return toned ? { native: toned, tonable: null } : null;
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

/** A run of text as written, or an emoji together with the shortcode it came from. */
export type EmojiTextToken =
  | { kind: 'text'; text: string }
  | { kind: 'emoji'; text: string; source: string };

interface TokenizeOptions {
  /** Indexes of colons that were escaped in the source and cannot delimit a shortcode. */
  literalColons?: ReadonlySet<number>;
}

const NO_LITERAL_COLONS: ReadonlySet<number> = new Set();

function urlRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = new RegExp(URL_SOURCE, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) { pattern.lastIndex += 1; continue; }
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/** Split text into plain runs and converted shortcodes. Joining every token's `text` gives the rendered string. */
export function tokenizeEmojiShortcodes(text: string, options: TokenizeOptions = {}): EmojiTextToken[] {
  if (!text.includes(':')) return [{ kind: 'text', text }];
  const literal = options.literalColons ?? NO_LITERAL_COLONS;
  const urls = urlRanges(text);
  const pattern = new RegExp(SHORTCODE_SOURCE, 'g');
  const tokens: EmojiTextToken[] = [];
  let copiedUpTo = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const name = match[1] ?? '';
    const close = start + name.length + 1;

    const url = urls.find(([from, to]) => start < to && close >= from);
    if (url) { pattern.lastIndex = Math.max(url[1], close); continue; }

    // A rejected candidate's closing colon may still open the next shortcode
    // (`:x::smile:`), so the search resumes there.
    if (isAsciiAlphanumeric(text[start - 1]) || literal.has(start) || literal.has(close)) {
      pattern.lastIndex = close;
      continue;
    }

    let end = close + 1;
    let pickerTone: number | null = null;
    if (match[2]) {
      const toneEnd = start + match[0].length;
      const toneUsable = !literal.has(close + 1) && !literal.has(toneEnd - 1) && !isAsciiAlphanumeric(text[toneEnd]);
      if (toneUsable) { end = toneEnd; pickerTone = Number(match[2]); }
    }
    if (isAsciiAlphanumeric(text[end])) { pattern.lastIndex = close; continue; }

    const resolved = resolveName(name);
    if (!resolved) { pattern.lastIndex = close; continue; }

    let native = resolved.native;
    if (pickerTone !== null) {
      const toned = resolved.tonable?.skins[pickerTone - 1]?.native;
      // An emoji without skin tones keeps the tone suffix as text.
      if (toned) native = toned;
      else end = close + 1;
    }

    if (start > copiedUpTo) tokens.push({ kind: 'text', text: text.slice(copiedUpTo, start) });
    tokens.push({ kind: 'emoji', text: native, source: text.slice(start, end) });
    copiedUpTo = end;
    pattern.lastIndex = end;
  }

  if (copiedUpTo < text.length) tokens.push({ kind: 'text', text: text.slice(copiedUpTo) });
  return tokens;
}

function joinTokens(tokens: EmojiTextToken[]): string {
  return tokens.map((token) => token.text).join('');
}

/** Replace every known `:shortcode:` in plain text with its emoji. */
export function replaceEmojiShortcodes(text: string): string {
  return joinTokens(tokenizeEmojiShortcodes(text));
}

// ─── Markdown source shown as plain text ────────────────────────────────────
// Reply previews, notifications and search results show a message's Markdown
// source without rendering it. The rendered message never converts inside
// code or a backslash-escaped colon, so neither do these.

const CODE_SPAN = /(```[\s\S]*?```|`[^`]+`)/g;

/** Colons written as `\:` (an odd run of backslashes before them). */
function escapedColons(text: string): Set<number> {
  const escaped = new Set<number>();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ':') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) backslashes += 1;
    if (backslashes % 2 === 1) escaped.add(i);
  }
  return escaped;
}

/** Tokens for Markdown source: code spans and escaped colons are left as written. */
export function tokenizeMarkdownSourceEmoji(source: string): EmojiTextToken[] {
  const tokens: EmojiTextToken[] = [];
  for (const [index, part] of source.split(CODE_SPAN).entries()) {
    if (!part) continue;
    // split() with one capture group puts the code spans at odd indexes.
    if (index % 2 === 1) tokens.push({ kind: 'text', text: part });
    else tokens.push(...tokenizeEmojiShortcodes(part, { literalColons: escapedColons(part) }));
  }
  return tokens;
}

/** Markdown source as plain text with its shortcodes converted. */
export function replaceEmojiShortcodesInMarkdownSource(source: string): string {
  return joinTokens(tokenizeMarkdownSourceEmoji(source));
}
