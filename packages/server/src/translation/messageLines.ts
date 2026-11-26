import { TranslationFault } from './errors.js';

function splitLinesWithSeparators(text: string): string[] {
  return text.split(/(\r\n|\r|\n)/);
}

function isNonEmptyLine(part: string, index: number): boolean {
  return index % 2 === 0 && part.trim().length > 0;
}

/**
 * Sends multi-line messages as an ordered array of non-empty lines so cross-line
 * context is preserved while layout-only blank lines stay local.
 */
export function buildUntrustedMessageInput(text: string): string | string[] {
  const content = splitLinesWithSeparators(text).filter(isNonEmptyLine);
  return content.length > 1 ? content : text;
}

export function reconstructMessageOutput(source: string, translatedValue: unknown): string {
  const parts = splitLinesWithSeparators(source);
  const content = parts.filter(isNonEmptyLine);

  if (content.length <= 1) {
    if (typeof translatedValue !== 'string' || !translatedValue.trim()) {
      throw new TranslationFault('provider_failed');
    }
    return translatedValue;
  }

  if (
    !Array.isArray(translatedValue) ||
    translatedValue.length !== content.length ||
    translatedValue.some((line) => typeof line !== 'string' || !line.trim() || /[\r\n]/.test(line))
  ) {
    throw new TranslationFault('provider_failed');
  }

  let cursor = 0;
  return parts
    .map((part, position) => (isNonEmptyLine(part, position) ? (translatedValue[cursor++] as string) : part))
    .join('');
}
