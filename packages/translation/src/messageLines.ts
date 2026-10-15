import { TranslationError } from './validation';

function lines(text: string): string[] { return text.split(/(\r\n|\r|\n)/); }
function hasContent(line: string, index: number): boolean { return index % 2 === 0 && !!line.trim(); }
/** One request retains cross-line context; the response must account for every nonempty source line. */
export function messageInput(text: string): string | string[] {
  const content = lines(text).filter(hasContent);
  return content.length > 1 ? content : text;
}
export function messageOutput(source: string, value: unknown): string {
  const parts = lines(source);
  const content = parts.filter(hasContent);
  if (content.length <= 1) {
    if (typeof value !== 'string' || !value.trim()) throw new TranslationError('invalid-response');
    return value;
  }
  if (!Array.isArray(value) || value.length !== content.length ||
    value.some(line => typeof line !== 'string' || !line.trim() || /[\r\n]/.test(line)))
    throw new TranslationError('invalid-response');
  let index = 0;
  // Keep blank lines and original separators locally rather than paying tokens for layout-only entries.
  return parts.map((part, position) => hasContent(part, position) ? value[index++] as string : part).join('');
}
