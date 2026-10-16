import type { BotCommandListing, BotCommandOption, ChannelType } from '@backspace/shared';

export type OptionValues = Record<string, string | number | boolean>;

/**
 * The spacing the composer keeps around the arguments of a command draft, so
 * each argument's capsule has room inside and out (the capsules are painted
 * over the text and cannot add width of their own): an em space between the
 * command and its first argument, an em and an en space between arguments,
 * and a thin and an en space after a colon. `spaceArguments` writes it,
 * whether an argument was picked from a list, typed or pasted. The parser
 * reads any whitespace there, so text with plain spaces means the same; the
 * server only ever sees the parsed options.
 */
export const HEAD_GAP = '\u2003';
export const ARG_SEPARATOR = '\u2003\u2002';
export const VALUE_GAP = '\u2009\u2002';

/** The command a draft starts with (`/name` and whitespace), lowercase, or null. */
export function draftCommandName(text: string): string | null {
  return /^\/([a-z0-9_-]+)\s/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

/** Whether options are the steps of a path (subcommands, groups) rather than values. */
export function holdsSubcommands(options: readonly BotCommandOption[]): boolean {
  return options.some((o) => o.type === 'subcommand' || o.type === 'subcommand_group');
}

/** Where a draft of a command stands: the subcommand path written after it, and what comes next. */
export interface CommandPath {
  /** The groups and the subcommand written after the command's name, in order. */
  path: string[];
  /** Just after the last word of the head: `/name` and the path. */
  headEnd: number;
  /** The value options the arguments are written for; null while the path does not reach them. */
  options: BotCommandOption[] | null;
  /** While the path does not reach them: the subcommands or groups to write next. */
  next: BotCommandOption[];
  /** The next step being typed at the end of the text, and where it starts; null when none is. */
  partial: { text: string; start: number } | null;
}

/**
 * Reads the head of a draft of `command`: `/name`, then for a command with
 * subcommands the words of its path (`/music queue add`), each a known step of
 * the level before, separated by spaces. A word at the very end is still being
 * typed (`partial`) unless the text is `final`, as when it is sent. Null when
 * the text is not this command.
 */
export function commandPath(text: string, command: BotCommandListing, final = false): CommandPath | null {
  const name = '/' + command.name;
  if (text.slice(0, name.length).toLowerCase() !== name) return null;
  if (name.length < text.length && !/\s/.test(text[name.length]!)) return null;
  const path: string[] = [];
  let headEnd = name.length;
  let level = command.options;
  while (holdsSubcommands(level)) {
    const stuck = (partial: CommandPath['partial'] = null): CommandPath => ({ path, headEnd, options: null, next: level, partial });
    let start = headEnd;
    while (start < text.length && /[^\S\n]/.test(text[start]!)) start++;
    if (start === headEnd) return stuck();
    let end = start;
    while (end < text.length && /[a-z0-9_-]/i.test(text[end]!)) end++;
    const word = text.slice(start, end);
    if (end === text.length && !final) return stuck({ text: word, start });
    if (end < text.length && !/\s/.test(text[end]!)) return stuck();
    const step = level.find((o) => o.name === word.toLowerCase());
    if (!step) return stuck();
    path.push(step.name);
    headEnd = end;
    if (step.type === 'subcommand') return { path, headEnd, options: step.options ?? [], next: [], partial: null };
    level = step.options ?? [];
  }
  return { path, headEnd, options: level, next: [], partial: null };
}

/**
 * Where a draft's arguments start and which options they are written for:
 * after the head and one space. Null while the head is not complete or no
 * space follows it yet.
 */
function argumentsOf(text: string, command: BotCommandListing): { start: number; headEnd: number; options: BotCommandOption[] } | null {
  const at = commandPath(text, command);
  if (!at || !at.options || at.headEnd >= text.length || !/\s/.test(text[at.headEnd]!)) return null;
  return { start: at.headEnd + 1, headEnd: at.headEnd, options: at.options };
}

/** One row of the command list: a command, or one subcommand of it with its path. */
export interface CommandRow {
  command: BotCommandListing;
  path: string[];
  description: string;
  /** The value options the row's command or subcommand takes. */
  options: BotCommandOption[];
}

/** The rows a command makes in the command list: itself, or each of its subcommands. */
export function commandRows(command: BotCommandListing): CommandRow[] {
  if (!holdsSubcommands(command.options)) {
    return [{ command, path: [], description: command.description, options: command.options }];
  }
  return command.options.flatMap((step) => step.type === 'subcommand'
    ? [{ command, path: [step.name], description: step.description, options: step.options ?? [] }]
    : (step.options ?? []).map((leaf) => ({
      command, path: [step.name, leaf.name], description: leaf.description, options: leaf.options ?? [],
    })));
}

/**
 * What the chat knows that typed values may name: its people, and its space's
 * roles and channels (none in a DM).
 */
export interface CommandArgContext {
  /** Each person with every name the chat shows for them: login, display name, space nickname. */
  users: ReadonlyArray<{ id: string; names: readonly string[] }>;
  roles: ReadonlyArray<{ id: string; name: string }>;
  channels: ReadonlyArray<{ id: string; name: string; type: ChannelType }>;
}

const NO_CONTEXT: CommandArgContext = { users: [], roles: [], channels: [] };

/** The one id with a name equal to `name` (case-insensitively), or null for none or several. */
function idByName<T extends { id: string }>(
  items: readonly T[],
  namesOf: (item: T) => readonly string[],
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  const ids = new Set(items.filter((item) => namesOf(item).some((n) => n.toLowerCase() === wanted)).map((item) => item.id));
  return ids.size === 1 ? [...ids][0]! : null;
}

/**
 * The id a typed user, role or channel value stands for: a token from the
 * picker (`<@id>`, `<@&id>`), or a name written by hand (`@login`, `@Display
 * name` in quotes, `@Role`, `#channel`, or the bare name) that names exactly one of them in
 * the chat; a channel must also be of an accepted type. Anything else goes
 * to the server as typed, which refuses it.
 */
function idOf(def: BotCommandOption, raw: string, context: CommandArgContext): string {
  if (def.type === 'user') {
    return /^<@([a-zA-Z0-9_-]+)>$/.exec(raw)?.[1]
      ?? idByName(context.users, (u) => u.names, raw.replace(/^@/, ''))
      ?? raw;
  }
  if (def.type === 'role') {
    return /^<@&([a-zA-Z0-9_-]+)>$/.exec(raw)?.[1]
      ?? idByName(context.roles, (r) => [r.name.replace(/^@/, '')], raw.replace(/^@/, ''))
      ?? raw;
  }
  const channels = context.channels.filter((c) => !def.channelTypes || def.channelTypes.includes(c.type));
  return idByName(channels, (c) => [c.name], raw.replace(/^#/, '')) ?? raw;
}

/** The option types whose values name someone or something in the chat. */
const NAMED_TYPES: ReadonlySet<BotCommandOption['type']> = new Set(['user', 'role', 'channel']);

/** Every name a hand-written value of `def` (a user, role or channel option) may give, from the chat. */
function namesOfType(def: BotCommandOption, context: CommandArgContext): string[] {
  if (def.type === 'user') return context.users.flatMap((u) => [...u.names]);
  if (def.type === 'role') return context.roles.map((r) => r.name.replace(/^@/, ''));
  if (def.type === 'channel') {
    return context.channels.filter((c) => !def.channelTypes || def.channelTypes.includes(c.type)).map((c) => c.name);
  }
  return [];
}

/**
 * How far a user, role or channel value written by hand runs in `rest` (the
 * text after its `name:`, up to the next option written by name) when it is
 * several words that together name someone or something in the chat
 * (`who:Bob Smith`, `where:#Big Voice`): the longest such run, within the
 * line. Null when no run of several words does; the value is then one word.
 */
function spacedNameLength(def: BotCommandOption, rest: string, context: CommandArgContext): number | null {
  if (!NAMED_TYPES.has(def.type) || rest.startsWith('"') || rest.startsWith('<')) return null;
  const line = rest.split('\n')[0]!;
  for (let end = line.length; end > 0; end--) {
    if (end < line.length && !/\s/.test(line[end]!)) continue;
    const candidate = line.slice(0, end).trimEnd();
    if (!/\s/.test(candidate)) return null;
    if (idOf(def, candidate, context) !== candidate) return candidate.length;
  }
  return null;
}

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

/**
 * The value of the choice `raw` names: a choice's name (what the list shows
 * and inserts) or its value written as is, case-insensitively. Undefined when
 * it is neither; the typed text then goes to the server, which refuses it.
 */
function choiceValue(def: BotCommandOption, raw: string): string | number | undefined {
  const wanted = raw.toLowerCase();
  const byName = def.choices?.find((c) => c.name.toLowerCase() === wanted);
  if (byName) return byName.value;
  return def.choices?.find((c) => String(c.value).toLowerCase() === wanted)?.value;
}

function setOptionValue(options: OptionValues, def: BotCommandOption, raw: string, context: CommandArgContext): void {
  if (raw.length === 0) return;
  const chosen = def.choices ? choiceValue(def, raw) : undefined;
  if (chosen !== undefined) {
    options[def.name] = chosen;
  } else if (def.type === 'integer' || def.type === 'number') {
    const n = Number(raw);
    options[def.name] = Number.isNaN(n) ? raw : n;
  } else if (def.type === 'boolean') {
    options[def.name] = raw === 'true' || raw === '1' || raw === 'yes';
  } else if (def.type === 'user' || def.type === 'role' || def.type === 'channel') {
    options[def.name] = idOf(def, raw, context);
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
/**
 * Where the next option written by name starts in `text` (whitespace, then a
 * `name:` of `defs`): the index of that whitespace, or -1. The names come from
 * bots, so they are compared as text, never built into a pattern.
 */
function nextNamedAt(text: string, defs: ReadonlyMap<string, unknown>): number {
  const word = /\s([a-z0-9_-]+):/gi;
  for (let m = word.exec(text); m; m = word.exec(text)) {
    if (defs.has(m[1]!.toLowerCase())) return m.index;
    word.lastIndex = m.index + 1;
  }
  return -1;
}

export function readNamedPairs(
  command: Pick<BotCommandListing, 'options'>,
  text: string,
  context: CommandArgContext = NO_CONTEXT,
): { options: OptionValues; rest: string } {
  const defs = new Map(command.options.map((o) => [o.name, o] as const));
  const options: OptionValues = {};
  let remaining = text.trim();
  for (;;) {
    const head = /^([a-z0-9_-]+):/i.exec(remaining);
    const def = head ? defs.get(head[1]!.toLowerCase()) : undefined;
    if (!head || !def) break;
    let body = remaining.slice(head[0].length).trimStart();
    let raw: string;
    const close = body.startsWith('"') ? body.indexOf('"', 1) : -1;
    const nextName = /^([a-z0-9_-]+):/i.exec(body);
    if (nextName && defs.has(nextName[1]!.toLowerCase())) {
      // `a: b:value`: a was left empty, b follows.
      raw = '';
    } else if (close > 0) {
      raw = body.slice(1, close);
      body = body.slice(close + 1);
    } else if (def.type === 'string') {
      const cut = nextNamedAt(body, defs);
      raw = (cut < 0 ? body : body.slice(0, cut)).trim();
      body = cut < 0 ? '' : body.slice(cut);
    } else {
      // A user, role or channel may be named by several words; anything else is one word.
      const cut = nextNamedAt(body, defs);
      const spaced = spacedNameLength(def, cut < 0 ? body : body.slice(0, cut), context);
      const space = body.search(/\s/);
      const length = spaced ?? (space < 0 ? body.length : space);
      raw = body.slice(0, length);
      body = body.slice(length);
    }
    setOptionValue(options, def, raw, context);
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
  command: Pick<BotCommandListing, 'options'>,
  rest: string,
  context: CommandArgContext = NO_CONTEXT,
): { ok: true; options: OptionValues } | { ok: false; extra: string } {
  const { options, rest: left } = readNamedPairs(command, rest, context);
  if (left.length === 0) return { ok: true, options };
  const target = [...command.options].reverse().find((o) => o.type === 'string' && !(o.name in options));
  if (!target) return { ok: false, extra: left };
  options[target.name] = left;
  return { ok: true, options };
}

/**
 * The options of a command that the draft `text` (`/name ...`) does not name
 * yet, the required ones first. A `name:` inside a quoted value names nothing.
 */
export function remainingOptions(command: BotCommandListing, text: string): BotCommandOption[] {
  const args = argumentsOf(text, command);
  if (!args) return [];
  const written = new Set(argumentFrames(text, command).map((f) => text.slice(f.nameStart, f.colonAt).toLowerCase()));
  const missing = args.options.filter((o) => !written.has(o.name));
  return [...missing.filter((o) => o.required), ...missing.filter((o) => !o.required)];
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
  context: CommandArgContext = NO_CONTEXT,
): OptionSuggest | null {
  const head = /^\/([a-z0-9_-]+)\s/i.exec(value);
  if (!head) return null;
  const name = head[1]!.toLowerCase();
  const command = picked && picked.name === name ? picked : commands.find((c) => c.name === name);
  if (!command) return null;
  // The options of the command, or of the subcommand its path names.
  const args = argumentsOf(value, command);
  if (!args || args.options.length === 0) return null;
  const tail = value.slice(args.start);
  // The word being typed starts after the last whitespace of any kind.
  let cut = tail.length;
  while (cut > 0 && !/\s/.test(tail[cut - 1]!)) cut--;
  const partial = tail.slice(cut);
  if (partial.includes(':')) return null;
  // `name: ` with no value yet: its values are offered, not more options.
  if (/(?:^|\s)[a-z0-9_-]+:\s+$/i.test(tail)) return null;
  if (readNamedPairs(args, tail.slice(0, cut), context).rest.length > 0) return null;
  return { command, query: partial.toLowerCase(), startIndex: args.start + cut, selectedIndex: 0, touched: false };
}

/** The subcommand popover: the next step of a command's path, typed at the end of the draft. */
export interface SubcommandSuggest {
  command: BotCommandListing;
  /** What has been typed of the step so far (lowercase). */
  query: string;
  /** Where that partial step starts in the draft. */
  startIndex: number;
  selectedIndex: number;
  /** An arrow key moved the selection: only then does Enter pick it instead of sending. */
  touched: boolean;
}

/**
 * The subcommand popover state for a draft, or null when none applies: the
 * text must start with a known command that has subcommands and a space, and
 * end while the next step of its path is being written (`/music `, `/music qu`,
 * `/music queue `).
 */
export function suggestSubcommand(
  value: string,
  commands: BotCommandListing[],
  picked: BotCommandListing | null,
): SubcommandSuggest | null {
  const name = draftCommandName(value);
  if (name === null) return null;
  const command = picked && picked.name === name ? picked : commands.find((c) => c.name === name);
  if (!command) return null;
  const at = commandPath(value, command);
  if (!at || at.options || !at.partial) return null;
  return { command, query: at.partial.text.toLowerCase(), startIndex: at.partial.start, selectedIndex: 0, touched: false };
}

/** The steps the subcommand popover offers: those of the next level whose names start with what is typed. */
export function subcommandMatches(suggest: SubcommandSuggest, text: string): BotCommandOption[] {
  const at = commandPath(text, suggest.command);
  return (at?.next ?? []).filter((o) => o.name.startsWith(suggest.query));
}

/**
 * The draft a picked command or subcommand starts: its head (`/music queue
 * add`), then its required options as `name:` ready to be filled in, spaced as
 * the composer spaces arguments. The caret goes into the first required
 * option's slot, or to the end when there is none.
 */
export function headDraft(command: BotCommandListing, path: readonly string[], options: readonly BotCommandOption[]): { text: string; caret: number } {
  const required = options.filter((o) => o.required);
  const written = ['/' + command.name, ...path].join(' ') + ' ' + required.map((o) => o.name + ':').join(' ');
  const { text } = spaceArguments(written, command, written.length);
  const first = argumentFrames(text, command)[0];
  const caret = required.length > 0 && first ? first.colonAt + 1 + VALUE_GAP.length : text.length;
  return { text, caret };
}

/** The value popover of a typed option: which option, and what of its value is typed so far. */
export interface ValueSuggest {
  command: BotCommandListing;
  option: BotCommandOption;
  /** The value typed so far, lowercase, without a leading `#` (channel) or `@` (user, role). */
  query: string;
  /** Where the value starts in the draft. */
  startIndex: number;
  selectedIndex: number;
  /** An arrow key moved the selection: only then does Enter pick it instead of sending. */
  touched: boolean;
}

/** The option types whose values the popover offers; any option with choices is offered its choices. */
const PICKED_TYPES: ReadonlySet<BotCommandOption['type']> = new Set(['user', 'role', 'channel', 'boolean']);

/** Whether the value popover offers anything for `option`. */
export function offersValues(option: BotCommandOption): boolean {
  return PICKED_TYPES.has(option.type) || (option.choices?.length ?? 0) > 0;
}

/**
 * The value popover state for a draft, or null when none applies: the text must
 * start with a known command, everything before the last `name:` must be
 * options written by name, and it must be `name:` (or `name: `) of a user, role,
 * channel or boolean option, or of an option with choices, followed by the
 * start of a value. A token or a
 * quoted value is not offered anything. (The mention picker does not open
 * here: it needs a space before the `@`.)
 */
export function suggestValue(
  value: string,
  commands: BotCommandListing[],
  picked: BotCommandListing | null,
  context: CommandArgContext = NO_CONTEXT,
): ValueSuggest | null {
  const head = /^\/([a-z0-9_-]+)\s/i.exec(value);
  if (!head) return null;
  const name = head[1]!.toLowerCase();
  const command = picked && picked.name === name ? picked : commands.find((c) => c.name === name);
  if (!command) return null;
  const args = argumentsOf(value, command);
  if (!args) return null;
  const tail = value.slice(args.start);
  // The option being filled is the last `name:` of the text, its value written
  // right after the colon or after its gap (`who:bo`, `who: bo`, VALUE_GAP).
  const word = /(^|\s)([a-z0-9_-]+):([^\S\n]{0,2})(\S*)$/i.exec(tail);
  if (!word) return suggestSpacedName(command, args.options, tail, args.start, context);
  const option = args.options.find((o) => o.name === word[2]!.toLowerCase());
  if (!option || !offersValues(option)) return null;
  const partial = word[4]!;
  if (partial.startsWith('"') || partial.startsWith('<')) return null;
  const before = word.index + word[1]!.length;
  if (readNamedPairs(args, tail.slice(0, before), context).rest.length > 0) return null;
  return {
    command,
    option,
    query: partial.replace(/^[#@]/, '').toLowerCase(),
    startIndex: args.start + before + word[2]!.length + 1 + word[3]!.length,
    selectedIndex: 0,
    touched: false,
  };
}

/**
 * The value popover while a user, role or channel name of several words is
 * typed by hand (`who:Bob Sm`): the last option written by name, its value
 * the start of a name in the chat, with a word begun after the space (just
 * after a space the next options are offered, as after any value). `offset`
 * is where `tail` starts in the draft.
 */
function suggestSpacedName(
  command: BotCommandListing,
  options: BotCommandOption[],
  tail: string,
  offset: number,
  context: CommandArgContext,
): ValueSuggest | null {
  let last: RegExpExecArray | null = null;
  const named = /(^|\s)([a-z0-9_-]+):/gi;
  for (let m = named.exec(tail); m; m = named.exec(tail)) last = m;
  if (!last) return null;
  const name = last[2]!.toLowerCase();
  const option = options.find((o) => o.name === name);
  if (!option || !NAMED_TYPES.has(option.type)) return null;
  const before = last.index + last[1]!.length;
  const colonEnd = before + name.length + 1;
  const gap = /^[^\S\n]{0,2}/.exec(tail.slice(colonEnd))![0].length;
  const typed = tail.slice(colonEnd + gap);
  // A space just typed asks for the next option; a second word started after it continues the name.
  if (!/\s\S/.test(typed) || /\s$/.test(typed) || typed.includes('\n') || typed.startsWith('"') || typed.startsWith('<')) return null;
  const query = typed.replace(/^[#@]/, '').toLowerCase();
  if (!namesOfType(option, context).some((n) => n.toLowerCase().startsWith(query))) return null;
  if (readNamedPairs({ options }, tail.slice(0, before), context).rest.length > 0) return null;
  return { command, option, query, startIndex: offset + colonEnd + gap, selectedIndex: 0, touched: false };
}

/** One argument of a command draft as the composer frames it: its `name:` and its value. */
export interface ArgumentFrame {
  /** Where `name:` starts; the name's box runs to `valueStart`. */
  nameStart: number;
  /** The colon, drawn hidden inside the name's box. */
  colonAt: number;
  /** Where the value's box starts: after the colon (and a thin space right after it). */
  valueStart: number;
  /** Where the value ends; equal to `valueStart` while no value is written. */
  valueEnd: number;
}

/**
 * Where the arguments of a draft that starts with `command` sit, in the text
 * as the textarea shows it, so the composer can draw each as a capsule:
 * `name:` and its value. A value is read as the parser reads it: one word, a
 * quoted run, or for a string option written without quotes, everything up
 * to the next option written by name. `units` are spans that count as one
 * word whatever they hold (a mention shown as `@Display name`); with the chat's
 * `context`, a user, role or channel named by several words is one value too.
 */
export function argumentFrames(
  text: string,
  command: BotCommandListing,
  units: ReadonlyArray<{ start: number; end: number }> = [],
  context?: CommandArgContext,
): ArgumentFrame[] {
  const args = argumentsOf(text, command);
  if (!args || args.options.length === 0) return [];
  const defs = new Map(args.options.map((o) => [o.name, o] as const));
  // Every `word:` after whitespace, kept when the word is one of the options
  // (the names come from bots: compared as text, never built into a pattern).
  const named = /(^|\s)([a-z0-9_-]+):/gi;
  const starts: Array<{ nameStart: number; colonAt: number; name: string }> = [];
  // A quoted value runs to its closing quote, whatever it holds; so does the parser.
  let quotedUntil = 0;
  for (let m = named.exec(text); m; m = named.exec(text)) {
    if (!defs.has(m[2]!.toLowerCase())) continue;
    if (m.index + m[1]!.length < args.start) continue;
    const nameStart = m.index + m[1]!.length;
    if (nameStart < quotedUntil) continue;
    // A `name:` inside a mention's shown name is part of the mention.
    if (units.some((u) => nameStart > u.start && nameStart < u.end)) continue;
    const colonAt = nameStart + m[2]!.length;
    starts.push({ nameStart, colonAt, name: m[2]!.toLowerCase() });
    const from = colonAt + 1 + /^[^\S\n]*/.exec(text.slice(colonAt + 1))![0].length;
    if (text[from] === '"') {
      const close = text.indexOf('"', from + 1);
      quotedUntil = close < 0 ? text.length : close + 1;
    }
  }
  return starts.map((start, i) => {
    const next = starts[i + 1]?.nameStart ?? text.length;
    // A thin space right after the colon pads the name; the spacing after it pads the value.
    const valueStart = start.colonAt + 1 + (text[start.colonAt + 1] === '\u2009' ? 1 : 0);
    const gap = /^[^\S\n]*/.exec(text.slice(valueStart, next))![0].length;
    const from = valueStart + gap;
    const rest = text.slice(from, next);
    let length: number;
    if (rest.startsWith('"')) {
      const close = rest.indexOf('"', 1);
      length = close > 0 ? close + 1 : rest.length;
    } else if (defs.get(start.name)?.type === 'string') {
      length = rest.trimEnd().length;
    } else {
      const unit = units.find((u) => u.start === from);
      const spaced = !unit && context ? spacedNameLength(defs.get(start.name)!, rest, context) : null;
      const space = rest.search(/\s/);
      length = unit ? unit.end - unit.start : spaced ?? (space < 0 ? rest.length : space);
    }
    return { nameStart: start.nameStart, colonAt: start.colonAt, valueStart, valueEnd: length > 0 ? from + length : valueStart };
  });
}

/**
 * Writes the composer's spacing (`HEAD_GAP`, `ARG_SEPARATOR`, `VALUE_GAP`)
 * around every argument of a draft that starts with `command`, in place of
 * whatever whitespace is there, and moves `caret` with the text. Only the
 * runs of spaces around `name:` change; a value's own spaces and line breaks
 * stay as written. A caret in the run after a colon goes behind the value's
 * gap, into the value's slot; a run before a name that holds the caret is left
 * as typed, since the person is writing there. Text already spaced comes back
 * unchanged.
 */
export function spaceArguments(text: string, command: BotCommandListing, caret: number): { text: string; caret: number } {
  const frames = argumentFrames(text, command);
  const head = commandPath(text, command);
  if (!head || frames.length === 0) return { text, caret };
  const isSpace = (char: string | undefined) => char !== undefined && /[^\S\n]/.test(char);
  // `caretAt`: where a caret in the run goes, as an offset into `insert`; null
  // leaves a run that holds the caret alone.
  const edits: Array<{ start: number; end: number; insert: string; caretAt: number | null }> = [];
  let spacedUpTo = -1;
  frames.forEach((frame, i) => {
    // Before the name, unless the run after the previous colon already covered it.
    let start = frame.nameStart;
    while (isSpace(text[start - 1])) start--;
    if (frame.nameStart > spacedUpTo && start > 0 && text[start - 1] !== '\n') {
      edits.push({ start, end: frame.nameStart, insert: start === head.headEnd ? HEAD_GAP : ARG_SEPARATOR, caretAt: null });
    }
    // After the colon: the value's gap, and the separator too when no value follows.
    const from = frame.colonAt + 1;
    let end = from;
    while (isSpace(text[end])) end++;
    if (end < text.length && text[end] === '\n') return;
    const next = frames[i + 1];
    if (next && end === next.nameStart) {
      edits.push({ start: from, end, insert: VALUE_GAP + ARG_SEPARATOR, caretAt: VALUE_GAP.length });
      spacedUpTo = end;
    } else {
      edits.push({ start: from, end, insert: VALUE_GAP, caretAt: VALUE_GAP.length });
    }
  });
  let spaced = text;
  let moved = caret;
  for (const edit of [...edits].reverse()) {
    const inside = edit.caretAt === null
      ? caret > edit.start && caret <= edit.end
      : caret >= edit.start && caret <= edit.end;
    if (inside && edit.caretAt === null) continue;
    if (text.slice(edit.start, edit.end) !== edit.insert) {
      spaced = spaced.slice(0, edit.start) + edit.insert + spaced.slice(edit.end);
    }
    if (inside) moved += edit.start + edit.caretAt! - caret;
    else if (caret > edit.end) moved += edit.insert.length - (edit.end - edit.start);
  }
  return { text: spaced, caret: moved };
}
