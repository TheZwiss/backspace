import { tokenizeEmojiShortcodes } from './emojiShortcodes';

// ─── remark plugin: `:shortcode:` → emoji ───────────────────────────────────
// Applied to text nodes only. Code spans and fenced blocks are `inlineCode`
// and `code` nodes, so what is written as code stays literal.
//
// Two things need the Markdown source, which the plugin reads from the file
// through each node's position:
//   - Escapes. remark has already turned `\:` into `:` in a text node's value,
//     so the plugin walks the node's source to find which colons were written
//     `\:` (or as the entities `&colon;`, `&#58;`, `&#x3a;`) and passes them
//     to the tokenizer as colons that cannot delimit a shortcode.
//     `\:smile\:` therefore renders as `:smile:`.
//   - Autolinks. A link written as a bare URL (`https://…`, `www.…`) or in
//     angle brackets shows its address as its text, and that text must read
//     exactly like the address. A labelled link (`[:tada: party](…)`, a
//     reference link) starts with `[` in the source and is converted like any
//     other text.

interface Point {
  offset?: number;
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  position?: { start: Point; end: Point };
}

interface SourceFile {
  value?: unknown;
}

const NO_LITERAL_COLONS: ReadonlySet<number> = new Set();
/** The characters CommonMark lets a backslash escape. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const COLON_ENTITY = /^&(?:colon|#0*58|#x0*3a);/i;

function sourceOf(node: MdastNode, source: string): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || !source) return null;
  return source.slice(start, end);
}

/**
 * Indexes (in the node's value) of the colons that were escaped in the
 * source. The value's colons appear in the same order as the source's colons,
 * written plainly, escaped or as an entity, so the two lists line up. If they
 * do not (a construct this walk does not know), no colon is treated as
 * escaped and the text converts as it would without escapes.
 */
function escapedColonIndexes(raw: string, value: string): ReadonlySet<number> {
  if (raw === value || (!raw.includes('\\') && !raw.includes('&'))) return NO_LITERAL_COLONS;

  const escapedInOrder: boolean[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const next = raw[i + 1];
    if (char === '\\' && next !== undefined && ESCAPABLE.test(next)) {
      if (next === ':') escapedInOrder.push(true);
      i += 1;
      continue;
    }
    if (char === '&') {
      const entity = COLON_ENTITY.exec(raw.slice(i));
      if (entity) {
        escapedInOrder.push(true);
        i += entity[0].length - 1;
        continue;
      }
    }
    if (char === ':') escapedInOrder.push(false);
  }

  const valueColons: number[] = [];
  for (let i = 0; i < value.length; i += 1) if (value[i] === ':') valueColons.push(i);
  if (valueColons.length !== escapedInOrder.length) return NO_LITERAL_COLONS;

  const escaped = new Set<number>();
  escapedInOrder.forEach((isEscaped, k) => { if (isEscaped) escaped.add(valueColons[k]!); });
  return escaped;
}

function plainText(node: MdastNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(plainText).join('');
}

function isAutolink(node: MdastNode, source: string): boolean {
  const raw = sourceOf(node, source);
  if (raw !== null) return !raw.startsWith('[');
  // No position to read: treat it as an autolink when its text is its address.
  const text = plainText(node);
  return node.url === text || node.url === `mailto:${text}` || node.url === `http://${text}`;
}

function convert(node: MdastNode, source: string): void {
  if (node.type === 'text' && typeof node.value === 'string') {
    if (!node.value.includes(':')) return;
    const raw = sourceOf(node, source);
    const literalColons = raw === null ? NO_LITERAL_COLONS : escapedColonIndexes(raw, node.value);
    node.value = tokenizeEmojiShortcodes(node.value, { literalColons }).map((token) => token.text).join('');
    return;
  }
  if (!node.children) return;
  if (node.type === 'link' && isAutolink(node, source)) return;
  for (const child of node.children) convert(child, source);
}

/** remark plugin: render `:shortcode:` text as emoji. */
export function remarkEmojiShortcodes() {
  return (tree: MdastNode, file: SourceFile) => {
    convert(tree, typeof file.value === 'string' ? file.value : '');
  };
}
