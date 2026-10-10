import { randomBytes } from 'crypto';
import { detectAll } from 'tinyld';
import type { TranslationLanguage, TranslationResult } from '../../shared/src/translation';
import { MAX_TEXT_LENGTH, TranslationError } from './validation';

// Keep code, URLs, emails and chat tokens out of model input, not just out of its instructions.
// Bound email components and reject nested sticker brackets so scans stay linear on hostile text.
const PROTECTED =
  /```[\s\S]*?(?:```|$)|`[^`\n]+`|sticker:https?:\/\/[^\s<>]+|https?:\/\/[^\s<>]+|[\w.+-]{1,64}@[\w.-]{1,253}\.[a-z]{2,63}|<[@#][!&]?[\w:-]+>|<a?:[\w-]+:[\w-]+>|\[sticker:[^\[\]]+\]/gi;
const SHORT_ENGLISH = /^(hello|thanks|thank you|goodbye|good morning|good night|please|yes|no)[.!?\s]*$/i;
export interface PreparedText {
  text: string;
  protectedParts: ReadonlyMap<string, string>;
}
export function naturalText(text: string): string {
  return text.replace(PROTECTED, ' ').trim();
}
// Obvious standalone source code is not chat prose, even when it lacks Markdown fences.
function looksLikeCode(text: string): boolean {
  if (
    /^(?:const|let|var)\s+[\w$]+\s*=|^(?:import|export)\s+.*(?:from\s*['"]|[{}])|^(?:def|class|function)\s+\w+\s*[:({]/u.test(
      text,
    )
  )
    return true;
  if (/^[\w.$]+\([^\n]*\);?$/u.test(text)) return true;
  if (!/^[{[]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
function detectedLanguage(natural: string): string | null {
  const detected = SHORT_ENGLISH.test(natural) ? [{ lang: 'en', accuracy: 1 }] : detectAll(natural);
  const best = detected[0];
  const runnerUp = detected[1]?.accuracy ?? 0;
  // Statistical scores are not probabilities. Short Latin fragments are too ambiguous to send automatically.
  const shortLatin =
    /^[\p{Script=Latin}\p{N}\p{P}\p{Z}\s]+$/u.test(natural) && natural.replace(/[^\p{L}]/gu, '').length < 12;
  if (
    !best ||
    best.accuracy < 0.1 ||
    best.accuracy < runnerUp * 2 ||
    (shortLatin && !SHORT_ENGLISH.test(natural))
  ) {
    return null;
  }
  return best.lang;
}
export function translationEligibility(text: string, target: TranslationLanguage): TranslationResult | null {
  if (!text || text.length > MAX_TEXT_LENGTH) throw new TranslationError('invalid-input');
  const natural = naturalText(text);
  if (looksLikeCode(natural) || !/\p{L}/u.test(natural)) return { kind: 'skipped', reason: 'not-text' };
  const preferred = target.startsWith('zh-') ? 'zh' : target;
  // A long preferred-language aside must not suppress foreign prose on another line.
  const languages = natural.split(/\r\n|\r|\n/).filter(line => /\p{L}/u.test(line) && !looksLikeCode(line.trim()))
    .map(line => detectedLanguage(line.trim()));
  if (languages.some(language => language !== null && language !== preferred)) return null;
  const language = detectedLanguage(natural);
  if (language === preferred) return { kind: 'skipped', reason: 'same-language' };
  if (language) return null;
  return { kind: 'skipped', reason: 'uncertain-language' };
}
export function protectText(text: string): PreparedText {
  const nonce = randomBytes(8).toString('hex');
  const protectedParts = new Map<string, string>();
  const masked = text.replace(PROTECTED, (part) => {
    const token = `__BS_${nonce}_${protectedParts.size}__`;
    protectedParts.set(token, part);
    return token;
  });
  return { text: masked, protectedParts };
}
export function restoreText(output: string, prepared: PreparedText): string {
  if (!output.trim() || output.length > MAX_TEXT_LENGTH * 4) throw new TranslationError('invalid-response');
  for (const token of prepared.protectedParts.keys()) {
    if (output.split(token).length !== 2) throw new TranslationError('protected-content');
  }
  // Replacement uses a callback: code containing "$&" must remain literal.
  return output.replace(/__BS_[a-f0-9]{16}_\d+__/g, (token) => {
    const original = prepared.protectedParts.get(token);
    if (original === undefined) throw new TranslationError('protected-content');
    return original;
  });
}
