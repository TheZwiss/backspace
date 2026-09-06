/**
 * Every string that ends up in the comment and originates from the pull
 * request (file names, package names, resolution URLs, commands, the author
 * login) passes through here. Git allows control characters, newlines,
 * backticks and pipes in file names, and Unicode bidi controls can make
 * `.github/workflows/ci.yml` render as something else entirely on a phone.
 * None of that may break out of a code span or a table cell, or reorder
 * what the maintainer reads.
 */

const MAX_INLINE = 120;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text safe to place inside a single-backtick code span in a table cell. */
export function inline(value: string): string {
  let text = value.replace(CONTROL_RE, '').replace(BIDI_RE, '').replaceAll('`', "'").replaceAll('|', '/').trim();
  if (text.length > MAX_INLINE) text = `${text.slice(0, MAX_INLINE - 1)}…`;
  return text === '' ? '(empty)' : text;
}

/** `inline` wrapped in backticks. */
export function code(value: string): string {
  return `\`${inline(value)}\``;
}

/**
 * A GitHub login is 1 to 39 alphanumerics or hyphens. Anything else is not
 * a login and is not mentioned; the greeting falls back to a plain word.
 */
export function login(value: string): string | null {
  return /^[A-Za-z0-9-]{1,39}$/.test(value) ? value : null;
}

/** Renders at most `max` items as code spans, then "and N more". */
export function codeList(values: string[], max = 10): string {
  const shown = values.slice(0, max).map(code);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}
