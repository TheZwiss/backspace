import React from 'react';
import { tokenizeMarkdownSourceEmoji } from '../../utils/emojiShortcodes';

const MARK_CLASS = 'bg-accent-primary/30 text-txt-primary rounded-sm px-0.5';

/** Every case-insensitive occurrence of the query in the text, as [start, end) ranges. */
function matchRanges(text: string, query: string): Array<[number, number]> {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'gi');
  const ranges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) { pattern.lastIndex += 1; continue; }
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * A search result's text with its shortcodes shown as emoji and the query
 * highlighted. The query is matched against the message as stored, because
 * that is what the server searched: an emoji is highlighted whole when the
 * query matches any part of the shortcode it came from, so `:tada:` and
 * `tada` both mark the 🎉.
 */
export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!text) return text;
  const tokens = tokenizeMarkdownSourceEmoji(text);
  const ranges = query.trim() ? matchRanges(text, query) : [];
  const nodes: React.ReactNode[] = [];
  let offset = 0;

  tokens.forEach((token, tokenIndex) => {
    const source = token.kind === 'emoji' ? token.source : token.text;
    const from = offset;
    const to = offset + source.length;
    offset = to;

    if (token.kind === 'emoji') {
      const hit = ranges.some(([start, end]) => start < to && end > from);
      nodes.push(hit
        ? <mark key={`e${tokenIndex}`} className={MARK_CLASS}>{token.text}</mark>
        : token.text);
      return;
    }

    let cursor = from;
    for (const [start, end] of ranges) {
      if (end <= cursor || start >= to) continue;
      const markFrom = Math.max(start, cursor);
      const markTo = Math.min(end, to);
      if (markFrom > cursor) nodes.push(text.slice(cursor, markFrom));
      nodes.push(<mark key={`t${tokenIndex}-${markFrom}`} className={MARK_CLASS}>{text.slice(markFrom, markTo)}</mark>);
      cursor = markTo;
    }
    if (cursor < to) nodes.push(text.slice(cursor, to));
  });

  return nodes;
}
