import { randomBytes } from 'node:crypto';
import { MAX_TRANSLATION_RESULT_LENGTH, MAX_TRANSLATION_SOURCE_LENGTH } from '@backspace/shared/src/translation.js';
import { TranslationFault } from './errors.js';

export const TEXT_POLICY_VERSION = 2;

export interface PreparedText {
  text: string;
  protectedParts: ReadonlyMap<string, string>;
}

function isAsciiAlphaNum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isEmailLocalChar(code: number): boolean {
  return isAsciiAlphaNum(code) || code === 46 || code === 95 || code === 43 || code === 45;
}

function isDomainChar(code: number): boolean {
  return isAsciiAlphaNum(code) || code === 46 || code === 45;
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isUrlStopChar(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\r' ||
    ch === '\n' ||
    ch === '<' ||
    ch === '>' ||
    ch === '[' ||
    ch === ']' ||
    ch === '"' ||
    ch === "'"
  );
}

function scanFencedOrInlineCode(text: string, pos: number): number {
  if (text.startsWith('```', pos)) {
    const close = text.indexOf('```', pos + 3);
    return close === -1 ? text.length : close + 3;
  }
  if (text.charCodeAt(pos) === 96 /* ` */) {
    let end = pos + 1;
    while (end < text.length) {
      const ch = text.charCodeAt(end);
      if (ch === 10 || ch === 13) return -1;
      if (ch === 96) return end > pos + 1 ? end + 1 : -1;
      end += 1;
    }
  }
  return -1;
}

function scanAngleToken(text: string, pos: number): number {
  if (text.charCodeAt(pos) !== 60 /* < */) return -1;
  const close = text.indexOf('>', pos + 1);
  if (close === -1 || close - pos > 512) return -1;
  const inner = text.slice(pos + 1, close);
  if (inner.includes('\n') || inner.includes('\r') || inner.includes(' ')) return -1;
  if (
    inner.startsWith('http://') ||
    inner.startsWith('https://') ||
    inner.startsWith('@') ||
    inner.startsWith('#') ||
    inner.startsWith(':') ||
    inner.startsWith('a:')
  ) {
    return close + 1;
  }
  return -1;
}

function scanBracketSticker(text: string, pos: number): number {
  if (!text.startsWith('[sticker:', pos)) return -1;
  let end = pos + 9;
  const limit = Math.min(text.length, pos + 512);
  while (end < limit) {
    const ch = text.charCodeAt(end);
    if (ch === 91 || ch === 10 || ch === 13) return -1;
    if (ch === 93 /* ] */) return end > pos + 9 ? end + 1 : -1;
    end += 1;
  }
  return -1;
}

function scanBareUrlOrSticker(text: string, pos: number): number {
  let startUrl = -1;
  if (text.startsWith('sticker:https://', pos) || text.startsWith('sticker:http://', pos)) {
    startUrl = pos + 8;
  } else if (text.startsWith('https://', pos) || text.startsWith('http://', pos)) {
    startUrl = pos;
  }
  if (startUrl === -1) return -1;
  let end = startUrl;
  while (end < text.length && !isUrlStopChar(text[end]!)) {
    end += 1;
  }
  // Trim trailing sentence punctuation so prose punctuation stays outside URL placeholders.
  while (end > startUrl + 8 && '.,;:!?)'.includes(text[end - 1]!)) {
    end -= 1;
  }
  return end > startUrl + 8 ? end : -1;
}

function scanEmailAt(text: string, pos: number): number {
  if (!isEmailLocalChar(text.charCodeAt(pos))) return -1;
  // Must start at beginning or after a non-email-local character so we don't split tokens.
  if (pos > 0 && isEmailLocalChar(text.charCodeAt(pos - 1))) return -1;
  let atPos = pos;
  const maxLocal = Math.min(text.length, pos + 65);
  while (atPos < maxLocal && isEmailLocalChar(text.charCodeAt(atPos))) {
    atPos += 1;
  }
  if (atPos === pos || atPos - pos > 64 || text.charCodeAt(atPos) !== 64 /* @ */) return -1;

  let domEnd = atPos + 1;
  const maxDom = Math.min(text.length, atPos + 1 + 254);
  while (domEnd < maxDom && isDomainChar(text.charCodeAt(domEnd))) {
    domEnd += 1;
  }
  const domain = text.slice(atPos + 1, domEnd);
  const lastDot = domain.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === domain.length - 1 || domain.length > 253) return -1;
  const tld = domain.slice(lastDot + 1);
  if (tld.length < 2 || tld.length > 63) return -1;
  for (let i = 0; i < tld.length; i += 1) {
    if (!isAsciiAlpha(tld.charCodeAt(i))) return -1;
  }
  return domEnd;
}

function scanMention(text: string, pos: number): number {
  if (text.charCodeAt(pos) !== 64 /* @ */) return -1;
  if (pos > 0 && (isAsciiAlphaNum(text.charCodeAt(pos - 1)) || text.charCodeAt(pos - 1) === 64)) {
    return -1;
  }
  let end = pos + 1;
  const limit = Math.min(text.length, pos + 129);
  while (end < limit) {
    const code = text.charCodeAt(end);
    if (isAsciiAlphaNum(code) || code === 95 || code === 45 || code === 46 || code === 64) {
      end += 1;
    } else {
      break;
    }
  }
  while (end > pos + 1 && '.,!?'.includes(text[end - 1]!)) {
    end -= 1;
  }
  return end > pos + 1 ? end : -1;
}

function scanShortcode(text: string, pos: number): number {
  if (text.charCodeAt(pos) !== 58 /* : */) return -1;
  if (pos > 0 && isAsciiAlphaNum(text.charCodeAt(pos - 1))) return -1;
  let end = pos + 1;
  const limit = Math.min(text.length, pos + 66);
  while (end < limit) {
    const code = text.charCodeAt(end);
    if (code === 58) {
      if (end === pos + 1) return -1;
      if (end + 1 < text.length && isAsciiAlphaNum(text.charCodeAt(end + 1))) return -1;
      return end + 1;
    }
    if (isAsciiAlphaNum(code) || code === 95 || code === 43 || code === 45) {
      end += 1;
    } else {
      return -1;
    }
  }
  return -1;
}

/**
 * Linear-time (`O(n)`) scanner that finds code blocks, inline code, URLs,
 * sticker tokens, angle-bracket mentions/channels/emojis, emails, `@mentions`,
 * and `:emoji:` shortcodes without regular-expression backtracking.
 */
export function scanProtectedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const end =
      scanFencedOrInlineCode(text, i) !== -1 ? scanFencedOrInlineCode(text, i)
      : scanAngleToken(text, i) !== -1 ? scanAngleToken(text, i)
      : scanBracketSticker(text, i) !== -1 ? scanBracketSticker(text, i)
      : scanBareUrlOrSticker(text, i) !== -1 ? scanBareUrlOrSticker(text, i)
      : scanEmailAt(text, i) !== -1 ? scanEmailAt(text, i)
      : scanMention(text, i) !== -1 ? scanMention(text, i)
      : scanShortcode(text, i);

    if (end > i) {
      spans.push([i, end]);
      i = end;
    } else {
      i += 1;
    }
  }
  return spans;
}

export function stripProtectedText(text: string): string {
  const spans = scanProtectedSpans(text);
  if (spans.length === 0) return text.trim();
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    out += text.slice(cursor, start) + ' ';
    cursor = end;
  }
  out += text.slice(cursor);
  return out.trim();
}

function looksLikeStandaloneJson(text: string): boolean {
  const first = text.charCodeAt(0);
  if (first !== 123 /* { */ && first !== 91 /* [ */) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function hasTranslatableText(text: string): boolean {
  if (!text) return false;
  if (text.length > MAX_TRANSLATION_SOURCE_LENGTH) {
    throw new TranslationFault('text_too_long');
  }
  const natural = stripProtectedText(text);
  if (!natural || looksLikeStandaloneJson(natural)) return false;
  return /\p{L}/u.test(natural);
}

export function protectText(text: string): PreparedText {
  if (text.length > MAX_TRANSLATION_SOURCE_LENGTH) {
    throw new TranslationFault('text_too_long');
  }
  const spans = scanProtectedSpans(text);
  if (spans.length === 0) {
    return { text, protectedParts: new Map() };
  }
  const nonce = randomBytes(8).toString('hex');
  const protectedParts = new Map<string, string>();
  let masked = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    const token = `__BS_${nonce}_${protectedParts.size}__`;
    protectedParts.set(token, text.slice(start, end));
    masked += text.slice(cursor, start) + token;
    cursor = end;
  }
  masked += text.slice(cursor);
  return { text: masked, protectedParts };
}

export function restoreProtectedText(output: string, prepared: PreparedText): string {
  if (!output.trim() || output.length > MAX_TRANSLATION_RESULT_LENGTH) {
    throw new TranslationFault('provider_failed');
  }
  if (prepared.protectedParts.size === 0) {
    return output;
  }
  // Normalize accidental markdown bold or casing around placeholders.
  const normalized = output.replace(
    /(?:__|\*\*)\s*BS_([a-fA-F0-9]{16})_(\d{1,4})\s*(?:__|\*\*)/g,
    (_, nonce: string, idx: string) => `__BS_${nonce.toLowerCase()}_${idx}__`,
  );

  for (const token of prepared.protectedParts.keys()) {
    if (normalized.split(token).length !== 2) {
      throw new TranslationFault('protected_content');
    }
  }

  return normalized.replace(/__BS_[a-f0-9]{16}_\d{1,4}__/g, (token) => {
    const original = prepared.protectedParts.get(token);
    if (original === undefined) {
      throw new TranslationFault('protected_content');
    }
    return original;
  });
}
