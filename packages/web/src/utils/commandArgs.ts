import type { BotCommandListing, BotCommandOption } from '@backspace/shared';

export type OptionValues = Record<string, string | number | boolean>;

export interface OptionSuggest {
  command: BotCommandListing;
  /** What has been typed of the option name so far (lowercase). */
  query: string;
  /** Where that partial name starts in the draft. */
  startIndex: number;
  selectedIndex: number;
  /** An arrow key moved the selection: only then does Enter pick it instead of sending. */
  touched: boolean;
}

function setOptionValue(options: OptionValues, def: BotCommandOption, raw: string): void {
  if (raw.length === 0) return;
  if (def.type === 'integer' || def.type === 'number') {
    const n = Number(raw);
    options[def.name] = Number.isNaN(n) ? raw : n;
  } else if (def.type === 'boolean') {
    options[def.name] = raw === 'true' || raw === '1' || raw === 'yes';
  } else {
    options[def.name] = raw;
  }
}

/**
 * Reads the options written by name at the start of `text`: `name:value`, where
 * a value is one word, or several in double quotes. A string option written
 * without quotes runs up to the next option written by name, or to the end, so
 * a title or a message may be any length. `rest` is what follows the last pair.
 */
export function readNamedPairs(command: BotCommandListing, text: string): { options: OptionValues; rest: string } {
  const defs = new Map(command.options.map((o) => [o.name, o] as const));
  const nextNamed = new RegExp('\\s(?:' + command.options.map((o) => o.name).join('|') + '):', 'i');
  const options: OptionValues = {};
  let remaining = text.trim();
  for (;;) {
    const head = /^([a-z0-9_-]+):/i.exec(remaining);
    const def = head ? defs.get(head[1]!.toLowerCase()) : undefined;
    if (!head || !def) break;
    let body = remaining.slice(head[0].length).trimStart();
    let raw: string;
    const close = body.startsWith('"') ? body.indexOf('"', 1) : -1;
    if (close > 0) {
      raw = body.slice(1, close);
      body = body.slice(close + 1);
    } else if (def.type === 'string') {
      const cut = body.search(nextNamed);
      raw = (cut < 0 ? body : body.slice(0, cut)).trim();
      body = cut < 0 ? '' : body.slice(cut);
    } else {
      const space = body.search(/\s/);
      raw = space < 0 ? body : body.slice(0, space);
      body = space < 0 ? '' : body.slice(space);
    }
    setOptionValue(options, def, raw);
    remaining = body.trim();
  }
  return { options, rest: remaining };
}

/**
 * The option values typed after a command. Options come first as name:value
 * pairs; whatever is left, spaces and all, is the value of the last string
 * option that was not given by name. Returns the leftover text when the command
 * has no string option to take it.
 */
export function parseCommandArgs(
  command: BotCommandListing,
  rest: string,
): { ok: true; options: OptionValues } | { ok: false; extra: string } {
  const { options, rest: left } = readNamedPairs(command, rest);
  if (left.length === 0) return { ok: true, options };
  const target = [...command.options].reverse().find((o) => o.type === 'string' && !(o.name in options));
  if (!target) return { ok: false, extra: left };
  options[target.name] = left;
  return { ok: true, options };
}

/** The optional options of a command that the text does not name yet. */
export function remainingOptions(command: BotCommandListing, text: string): BotCommandOption[] {
  return command.options.filter(
    (o) => !o.required && !new RegExp('(?:^|\\s)' + o.name + ':', 'i').test(text),
  );
}

/**
 * The option popover state for a draft, or null when none applies: the text must
 * start with a known command and a space, everything after it must be options
 * written by name, and the word being typed must not be a value.
 */
export function suggestOptions(
  value: string,
  commands: BotCommandListing[],
  picked: BotCommandListing | null,
): OptionSuggest | null {
  const head = /^\/([a-z0-9_-]+)\s/i.exec(value);
  if (!head) return null;
  const name = head[1]!.toLowerCase();
  const command = picked && picked.name === name ? picked : commands.find((c) => c.name === name);
  if (!command || command.options.length === 0) return null;
  const tail = value.slice(head[0].length);
  const cut = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n')) + 1;
  const partial = tail.slice(cut);
  if (partial.includes(':')) return null;
  if (readNamedPairs(command, tail.slice(0, cut)).rest.length > 0) return null;
  return { command, query: partial.toLowerCase(), startIndex: head[0].length + cut, selectedIndex: 0, touched: false };
}
