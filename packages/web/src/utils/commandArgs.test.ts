import { describe, expect, it } from 'vitest';
import type { BotCommandListing, BotCommandOption } from '@backspace/shared';
import {
  ARG_SEPARATOR, HEAD_GAP, VALUE_GAP, argumentFrames, commandPath, commandRows, draftCommandName, headDraft, parseCommandArgs,
  remainingOptions, spaceArguments, subcommandMatches, suggestOptions, suggestSubcommand, suggestValue, type CommandArgContext,
} from './commandArgs';

function option(name: string, type: BotCommandOption['type'], required = false): BotCommandOption {
  return { name, description: name, type, required };
}

function listing(name: string, options: BotCommandOption[]): BotCommandListing {
  return {
    id: `cmd-${name}`,
    botId: 'bot-1',
    name,
    description: name,
    options,
    updatedAt: 0,
    bot: { id: 'bot-1', username: 'player_bot', displayName: 'player_bot', avatar: null, avatarColor: 'mint' },
  };
}

const play = listing('play', [option('query', 'string', true), option('volume', 'integer'), option('loop', 'boolean')]);
const roll = listing('roll', [option('sides', 'integer')]);

describe('parseCommandArgs', () => {
  it('gives the text after named options to the last string option not named', () => {
    expect(parseCommandArgs(play, 'volume:80 любое название')).toEqual({
      ok: true,
      options: { volume: 80, query: 'любое название' },
    });
  });

  it('takes plain text as the last string option', () => {
    expect(parseCommandArgs(play, 'hello there')).toEqual({ ok: true, options: { query: 'hello there' } });
  });

  it('reads a quoted value of several words', () => {
    expect(parseCommandArgs(play, 'query:"hello world" loop:true')).toEqual({
      ok: true,
      options: { query: 'hello world', loop: true },
    });
  });

  it('lets a string option run up to the next named option', () => {
    expect(parseCommandArgs(play, 'query:some long title volume:5')).toEqual({
      ok: true,
      options: { query: 'some long title', volume: 5 },
    });
  });

  it('keeps a URL as text, not as a named option', () => {
    expect(parseCommandArgs(play, 'https://example.org/a?b=c')).toEqual({
      ok: true,
      options: { query: 'https://example.org/a?b=c' },
    });
  });

  it('keeps a non-numeric value as written, for the server to refuse', () => {
    expect(parseCommandArgs(play, 'volume:loud query:x')).toEqual({
      ok: true,
      options: { volume: 'loud', query: 'x' },
    });
  });

  it('reports the leftover text when no string option can take it', () => {
    expect(parseCommandArgs(roll, 'sides:6 extra words')).toEqual({ ok: false, extra: 'extra words' });
  });

  it('reads boolean spellings', () => {
    expect(parseCommandArgs(play, 'query:x loop:yes')).toEqual({ ok: true, options: { query: 'x', loop: true } });
    expect(parseCommandArgs(play, 'query:x loop:no')).toEqual({ ok: true, options: { query: 'x', loop: false } });
  });

  it('leaves a missing required option to the server', () => {
    expect(parseCommandArgs(play, '')).toEqual({ ok: true, options: {} });
  });
});

describe('remainingOptions', () => {
  it('offers the options that are not written yet', () => {
    expect(remainingOptions(play, '/play query:x volume:3').map((o) => o.name)).toEqual(['loop']);
    expect(remainingOptions(play, '/play query:x').map((o) => o.name)).toEqual(['volume', 'loop']);
  });

  it('puts a required option that is not written yet first', () => {
    expect(remainingOptions(play, '/play volume:3').map((o) => o.name)).toEqual(['query', 'loop']);
    expect(remainingOptions(play, '/play ').map((o) => o.name)).toEqual(['query', 'volume', 'loop']);
  });
});

describe('suggestOptions', () => {
  const commands = [play, roll];

  it('opens after "/name " and follows the word being typed', () => {
    expect(suggestOptions('/play ', commands, null)).toMatchObject({ query: '', startIndex: 6 });
    expect(suggestOptions('/play vo', commands, null)).toMatchObject({ query: 'vo', startIndex: 6 });
    expect(suggestOptions('/play VO', commands, null)).toMatchObject({ query: 'vo', startIndex: 6 });
  });

  it('opens again after a complete named option', () => {
    expect(suggestOptions('/play query:x ', commands, null)).toMatchObject({ query: '', startIndex: 14 });
  });

  it('stays closed while free text is typed', () => {
    expect(suggestOptions('/play hello wor', commands, null)).toBeNull();
  });

  it('stays closed while a value is being typed', () => {
    expect(suggestOptions('/play vol:', commands, null)).toBeNull();
  });

  it('stays closed for an unknown command or before the space', () => {
    expect(suggestOptions('/nope ', commands, null)).toBeNull();
    expect(suggestOptions('/play', commands, null)).toBeNull();
  });

  it('prefers the command that was picked from the list', () => {
    expect(suggestOptions('/play ', [], play)).toMatchObject({ query: '', startIndex: 6 });
  });
});

describe('typed values', () => {
  const kick = listing('kick', [
    option('who', 'user', true),
    { ...option('where', 'channel'), channelTypes: ['voice'] },
    option('group', 'role'),
    option('reason', 'string'),
  ]);
  const context: CommandArgContext = {
    users: [{ id: 'u1', names: ['bob', 'Bobby'] }, { id: 'u2', names: ['Ann'] }, { id: 'u3', names: ['quddymusic', 'Quddy'] }],
    roles: [{ id: 'r1', name: 'Mods' }, { id: 'r2', name: 'mods-old' }],
    channels: [
      { id: 'c1', name: 'lounge', type: 'voice' },
      { id: 'c2', name: 'general', type: 'text' },
      { id: 'c3', name: 'general', type: 'voice' },
    ],
  };

  it('reads the tokens the picker writes', () => {
    expect(parseCommandArgs(kick, 'who:<@u9> group:<@&r9> where:#lounge spamming', context)).toEqual({
      ok: true,
      options: { who: 'u9', group: 'r9', where: 'c1', reason: 'spamming' },
    });
  });

  it('turns names written by hand into ids when exactly one matches', () => {
    expect(parseCommandArgs(kick, 'who:@ann group:@mods where:general', context)).toEqual({
      ok: true,
      // Two channels are named general, but only one is a voice channel.
      options: { who: 'u2', group: 'r1', where: 'c3' },
    });
  });

  it('matches a person by login, display name or nickname, and a quoted channel name with a space', () => {
    const spaced: CommandArgContext = { ...context, channels: [{ id: 'c9', name: 'Big Voice', type: 'voice' }] };
    expect(parseCommandArgs(kick, 'who:@Quddy where:"#Big Voice"', spaced)).toEqual({
      ok: true,
      options: { who: 'u3', where: 'c9' },
    });
    expect(parseCommandArgs(kick, 'who:bobby', context)).toEqual({ ok: true, options: { who: 'u1' } });
  });

  it('leaves an unknown name as written, for the server to refuse', () => {
    expect(parseCommandArgs(kick, 'who:@nobody where:#general2', context)).toEqual({
      ok: true,
      options: { who: '@nobody', where: '#general2' },
    });
  });
});

describe('suggestValue', () => {
  const ban = listing('ban', [option('who', 'user', true), option('silent', 'boolean'), option('reason', 'string')]);

  it('opens while the value of a user, role, channel or boolean option is typed', () => {
    expect(suggestValue('/ban who:', [ban], null)).toMatchObject({ query: '', startIndex: 9 });
    expect(suggestValue('/ban who:@Bo', [ban], null)).toMatchObject({ query: 'bo', startIndex: 9 });
    expect(suggestValue('/ban who:<@u1> silent:t', [ban], null)).toMatchObject({ query: 't', startIndex: 22 });
  });

  it('stays closed for a string option, a token, a quoted value and free text before', () => {
    expect(suggestValue('/ban reason:', [ban], null)).toBeNull();
    expect(suggestValue('/ban who:<@u1', [ban], null)).toBeNull();
    expect(suggestValue('/ban who:"bo', [ban], null)).toBeNull();
    expect(suggestValue('/ban hello who:', [ban], null)).toBeNull();
  });
});

describe('choices', () => {
  const vol = listing('vol', [
    { ...option('level', 'integer', true), choices: [{ name: 'quiet', value: 20 }, { name: 'very loud', value: 95 }] },
    { ...option('mode', 'string'), choices: [{ name: 'Shuffle', value: 'shuffle' }] },
  ]);

  it('sends the value of a choice written by name, quoted or not, or by its value', () => {
    expect(parseCommandArgs(vol, 'level:quiet mode:Shuffle')).toEqual({ ok: true, options: { level: 20, mode: 'shuffle' } });
    expect(parseCommandArgs(vol, 'level:"very loud"')).toEqual({ ok: true, options: { level: 95 } });
    expect(parseCommandArgs(vol, 'level:95')).toEqual({ ok: true, options: { level: 95 } });
  });

  it('leaves a name that is not a choice for the server to refuse', () => {
    expect(parseCommandArgs(vol, 'level:medium')).toEqual({ ok: true, options: { level: 'medium' } });
  });

  it('opens the value list for an option with choices', () => {
    expect(suggestValue('/vol level:q', [vol], null)).toMatchObject({ query: 'q', startIndex: 11 });
    expect(suggestValue('/vol mode:', [vol], null)).toMatchObject({ query: '' });
  });
});

describe('argumentFrames', () => {
  it('frames each name: and its value, a quoted value and a free-text string up to the next name', () => {
    const text = '/play query:any long title volume:80 loop:';
    const frames = argumentFrames(text, play);
    expect(frames.map((f) => [text.slice(f.nameStart, f.valueStart), text.slice(f.valueStart, f.valueEnd)])).toEqual([
      ['query:', 'any long title'],
      ['volume:', '80'],
      ['loop:', ''],
    ]);
    const quoted = '/play query:"a b" loop:true';
    expect(argumentFrames(quoted, play).map((f) => quoted.slice(f.valueStart, f.valueEnd))).toEqual(['"a b"', 'true']);
  });

  it('takes a shown mention as one value, and frames nothing for another command or before the space', () => {
    const kick = listing('kick', [option('who', 'user', true), option('reason', 'string')]);
    const text = '/kick who:@Bob Smith reason:spam';
    const frames = argumentFrames(text, kick, [{ start: 10, end: 20 }]);
    expect(text.slice(frames[0]!.valueStart, frames[0]!.valueEnd)).toBe('@Bob Smith');
    expect(argumentFrames('/play', play)).toEqual([]);
    expect(argumentFrames('/roll sides:6', play)).toEqual([]);
  });
});

describe('a space after the colon', () => {
  const ban = listing('ban', [option('who', 'user', true), option('silent', 'boolean'), option('reason', 'string')]);

  it('is read as part of the gap: values parse as without it, and an empty value stays empty', () => {
    expect(parseCommandArgs(ban, 'who: <@u1> silent: true')).toEqual({ ok: true, options: { who: 'u1', silent: true } });
    expect(parseCommandArgs(ban, 'who: silent: true')).toEqual({ ok: true, options: { silent: true } });
    expect(parseCommandArgs(ban, 'reason: spam silent:true')).toEqual({ ok: true, options: { reason: 'spam', silent: true } });
  });

  it('keeps the value list open after `name: ` and the option list closed', () => {
    expect(suggestValue('/ban who: ', [ban], null)).toMatchObject({ query: '', startIndex: 10 });
    expect(suggestValue('/ban who: bo', [ban], null)).toMatchObject({ query: 'bo', startIndex: 10 });
    expect(suggestOptions('/ban who: ', [ban], null)).toBeNull();
    expect(suggestValue('/ban who: <@u1> ', [ban], null)).toBeNull();
    expect(suggestOptions('/ban who: <@u1> ', [ban], null)).toMatchObject({ query: '' });
  });

  it('belongs to the value\'s box; an empty value has no box', () => {
    const text = '/ban who: <@u1> silent: ';
    const frames = argumentFrames(text, ban);
    expect(frames.map((f) => [text.slice(f.nameStart, f.valueStart), text.slice(f.valueStart, f.valueEnd)])).toEqual([
      ['who:', ' <@u1>'],
      ['silent:', ''],
    ]);
  });
});

describe('the spacing the composer writes', () => {
  const ban = listing('ban', [option('who', 'user', true), option('silent', 'boolean'), option('reason', 'string')]);
  const who = '/ban' + HEAD_GAP + 'who:' + VALUE_GAP;

  it('parses as plain spaces do', () => {
    const rest = 'who:' + VALUE_GAP + '<@u1>' + ARG_SEPARATOR + 'reason:' + VALUE_GAP + 'spam' + ARG_SEPARATOR + 'silent:' + VALUE_GAP + 'true';
    expect(parseCommandArgs(ban, rest)).toEqual({ ok: true, options: { who: 'u1', reason: 'spam', silent: true } });
    expect(parseCommandArgs(ban, 'who:' + VALUE_GAP + ARG_SEPARATOR + 'silent:' + VALUE_GAP)).toEqual({ ok: true, options: {} });
    expect(draftCommandName(who)).toBe('ban');
  });

  it('keeps the value list open in the gap, and offers options after a typed space', () => {
    expect(suggestValue(who, [ban], null)).toMatchObject({ query: '', startIndex: who.length });
    expect(suggestValue(who + 'bo', [ban], null)).toMatchObject({ query: 'bo', startIndex: who.length });
    expect(suggestOptions(who, [ban], null)).toBeNull();
    expect(suggestOptions(who + '<@u1> ', [ban], null)).toMatchObject({ query: '', startIndex: who.length + 6 });
    expect(suggestOptions('/ban' + ARG_SEPARATOR, [ban], null)).toMatchObject({ query: '', startIndex: 6 });
    expect(suggestOptions(who + '<@u1> ', [ban], null)).toMatchObject({ query: '' });
  });

  it('gives the thin space to the name\'s box and the en space to the value\'s', () => {
    const text = who + '<@u1>' + ARG_SEPARATOR + 'silent:' + VALUE_GAP;
    const frames = argumentFrames(text, ban);
    expect(frames.map((f) => [text.slice(f.nameStart, f.colonAt), text.slice(f.nameStart, f.valueStart), text.slice(f.valueStart, f.valueEnd)])).toEqual([
      ['who', 'who:\u2009', '\u2002<@u1>'],
      ['silent', 'silent:\u2009', ''],
    ]);
  });
});

describe('spaceArguments', () => {
  const ban = listing('ban', [option('who', 'user', true), option('silent', 'boolean'), option('reason', 'string')]);
  const spaced = '/ban' + HEAD_GAP + 'who:' + VALUE_GAP + '<@u1>' + ARG_SEPARATOR + 'reason:' + VALUE_GAP + 'too much spam';

  it('spaces a pasted command as the composer writes it, and keeps a value\'s own spaces', () => {
    const pasted = '/ban who:<@u1> reason: too much spam';
    expect(spaceArguments(pasted, ban, pasted.length)).toEqual({ text: spaced, caret: spaced.length });
    expect(spaceArguments(spaced, ban, 3)).toEqual({ text: spaced, caret: 3 });
  });

  it('gives a just typed colon its gap and moves the caret past it', () => {
    const typed = '/ban who:';
    const text = '/ban' + HEAD_GAP + 'who:' + VALUE_GAP;
    expect(spaceArguments(typed, ban, typed.length)).toEqual({ text, caret: text.length });
  });

  it('spaces an empty value followed by the next option, and leaves line breaks and other commands alone', () => {
    const text = '/ban who: silent:';
    const want = '/ban' + HEAD_GAP + 'who:' + VALUE_GAP + ARG_SEPARATOR + 'silent:' + VALUE_GAP;
    expect(spaceArguments(text, ban, 9).text).toBe(want);
    expect(spaceArguments(text, ban, 9).caret).toBe(('/ban' + HEAD_GAP + 'who:' + VALUE_GAP).length);
    expect(spaceArguments('/ban reason:a\nsilent:true', ban, 0).text).toBe('/ban' + HEAD_GAP + 'reason:' + VALUE_GAP + 'a\nsilent:' + VALUE_GAP + 'true');
    expect(spaceArguments('/kick who:x', ban, 0)).toEqual({ text: '/kick who:x', caret: 0 });
  });

  it('leaves a space typed before the next option alone, so a new option can be written there', () => {
    const before = '/ban' + HEAD_GAP + 'who:' + VALUE_GAP + '<@u1>';
    const after = ARG_SEPARATOR + 'reason:' + VALUE_GAP + 'spam';
    // A space typed right after the value, in front of the separator.
    const typed = before + ' ' + after;
    expect(spaceArguments(typed, ban, before.length + 1)).toEqual({ text: typed, caret: before.length + 1 });
    // Then `silent:` there: it gets its spacing and the caret goes into its slot.
    const named = before + ' silent:' + after;
    const want = before + ARG_SEPARATOR + 'silent:' + VALUE_GAP + ARG_SEPARATOR + 'reason:' + VALUE_GAP + 'spam';
    const caret = (before + ARG_SEPARATOR + 'silent:' + VALUE_GAP).length;
    expect(spaceArguments(named, ban, (before + ' silent:').length)).toEqual({ text: want, caret });
  });

  it('does not read a name inside a quoted value as an option', () => {
    const text = '/ban reason:"ask who:me" silent:true';
    const want = '/ban' + HEAD_GAP + 'reason:' + VALUE_GAP + '"ask who:me"' + ARG_SEPARATOR + 'silent:' + VALUE_GAP + 'true';
    expect(spaceArguments(text, ban, text.length).text).toBe(want);
    expect(remainingOptions(ban, want).map((o) => o.name)).toEqual(['who']);
  });
});

describe('names of several words typed by hand', () => {
  const kick = listing('kick', [
    option('who', 'user', true),
    { ...option('where', 'channel'), channelTypes: ['voice'] },
    option('group', 'role'),
    option('times', 'integer'),
    option('reason', 'string'),
  ]);
  const context: CommandArgContext = {
    users: [{ id: 'u1', names: ['bob', 'Bob Smith'] }, { id: 'u2', names: ['ann', 'Ann Lee'] }],
    roles: [{ id: 'r1', name: 'Night Shift' }],
    channels: [{ id: 'c1', name: 'Big Voice', type: 'voice' }, { id: 'c2', name: 'Big Text', type: 'text' }],
  };

  it('reads a run of words that names someone or something in the chat as one value', () => {
    expect(parseCommandArgs(kick, 'who:Bob Smith times:3', context)).toEqual({ ok: true, options: { who: 'u1', times: 3 } });
    expect(parseCommandArgs(kick, 'who:@Ann Lee group:@Night Shift where:#Big Voice', context))
      .toEqual({ ok: true, options: { who: 'u2', group: 'r1', where: 'c1' } });
    // One word when no run names anyone: the rest is free text, here the reason.
    expect(parseCommandArgs(kick, 'who:bob was rude', context)).toEqual({ ok: true, options: { who: 'u1', reason: 'was rude' } });
    // A channel of a type the option does not take is not a name for it.
    expect(parseCommandArgs(kick, 'who:bob where:#Big Text', context)).toEqual({ ok: true, options: { who: 'u1', where: '#Big', reason: 'Text' } });
  });

  it('frames the whole name, and only with the chat at hand', () => {
    const text = '/kick who:Bob Smith times:3';
    const slices = (frames: ReturnType<typeof argumentFrames>) => frames.map((f) => text.slice(f.valueStart, f.valueEnd));
    expect(slices(argumentFrames(text, kick, [], context))).toEqual(['Bob Smith', '3']);
    expect(slices(argumentFrames(text, kick))).toEqual(['Bob', '3']);
  });

  it('offers the names while the second word is typed, and the options right after a space', () => {
    const who = '/kick who:' + VALUE_GAP;
    expect(suggestValue(who + 'Bob Sm', [kick], null, context)).toMatchObject({ query: 'bob sm', startIndex: who.length });
    expect(suggestValue(who + 'Bob ', [kick], null, context)).toBeNull();
    expect(suggestOptions(who + 'Bob ', [kick], null, context)).toMatchObject({ query: '' });
    expect(suggestValue(who + 'Bob Smith ', [kick], null, context)).toBeNull();
    expect(suggestOptions(who + 'Bob Smith ', [kick], null, context)).toMatchObject({ query: '' });
    // Without the chat, `Smith` would be left over and no options offered.
    expect(suggestOptions(who + 'Bob Smith ', [kick], null)).toBeNull();
    expect(suggestValue(who + 'Bob Xy', [kick], null, context)).toBeNull();
  });
});

describe('subcommands', () => {
  const step = (name: string, type: 'subcommand' | 'subcommand_group', options: BotCommandOption[]): BotCommandOption =>
    ({ name, description: `${name} it`, type, required: false, options });
  const music = listing('music', [
    step('play', 'subcommand', [option('query', 'string', true), option('loud', 'boolean')]),
    step('queue', 'subcommand_group', [step('add', 'subcommand', [option('who', 'user', true)]), step('list', 'subcommand', [])]),
  ]);
  const names = (options: readonly BotCommandOption[]) => options.map((o) => o.name);

  it('reads the path written after the command', () => {
    expect(commandPath('/music', music)).toMatchObject({ path: [], options: null, partial: null });
    expect(commandPath('/music ', music)).toMatchObject({ path: [], options: null, partial: { text: '', start: 7 } });
    expect(commandPath('/music qu', music)).toMatchObject({ options: null, partial: { text: 'qu', start: 7 } });
    expect(commandPath('/music queue ', music)).toMatchObject({ path: ['queue'], partial: { text: '', start: 13 } });
    expect(commandPath('/music queue add who:x', music)).toMatchObject({ path: ['queue', 'add'], headEnd: 16, options: [{ name: 'who' }] });
    // A last word still being typed counts once the text is sent.
    expect(commandPath('/music queue list', music)).toMatchObject({ options: null, partial: { text: 'list' } });
    expect(commandPath('/music queue list', music, true)).toMatchObject({ path: ['queue', 'list'], options: [] });
    expect(names(commandPath('/music stop now', music)!.next)).toEqual(['play', 'queue']);
    expect(commandPath('/musicx', music)).toBeNull();
    expect(commandPath('/play x', play)).toMatchObject({ path: [], headEnd: 5, options: play.options });
  });

  it('makes a row of each subcommand, and one of a command without them', () => {
    expect(commandRows(music).map((r) => [r.path.join(' '), r.description, names(r.options)])).toEqual([
      ['play', 'play it', ['query', 'loud']],
      ['queue add', 'add it', ['who']],
      ['queue list', 'list it', []],
    ]);
    expect(commandRows(play).map((r) => r.path)).toEqual([[]]);
  });

  it('offers the next step until the path reaches a subcommand, then its options', () => {
    const offered = (text: string) => {
      const suggest = suggestSubcommand(text, [music], null);
      return suggest ? names(subcommandMatches(suggest, text)) : null;
    };
    expect(offered('/music ')).toEqual(['play', 'queue']);
    expect(offered('/music q')).toEqual(['queue']);
    expect(offered('/music queue ')).toEqual(['add', 'list']);
    expect(offered('/music queue a')).toEqual(['add']);
    expect(offered('/music play ')).toBeNull();
    expect(suggestOptions('/music ', [music], null)).toBeNull();
    expect(suggestOptions('/music play ', [music], null)).toMatchObject({ query: '', startIndex: 12 });
    expect(names(remainingOptions(music, '/music play loud:true '))).toEqual(['query']);
    expect(offered('/play ')).toBeNull();
  });

  it('frames, offers, parses and spaces the arguments after the path', () => {
    const text = '/music queue add who:bob';
    expect(argumentFrames(text, music).map((f) => text.slice(f.valueStart, f.valueEnd))).toEqual(['bob']);
    expect(spaceArguments(text, music, text.length).text).toBe('/music queue add' + HEAD_GAP + 'who:' + VALUE_GAP + 'bob');
    expect(suggestValue('/music queue add who:b', [music], null)).toMatchObject({ option: { name: 'who' }, query: 'b', startIndex: 21 });
    const leaf = commandPath('/music play query:song loud:true', music)!;
    expect(parseCommandArgs({ options: leaf.options! }, 'query:song loud:true')).toEqual({ ok: true, options: { query: 'song', loud: true } });
    // Before the path is complete there are no arguments.
    expect(argumentFrames('/music queue who:bob', music)).toEqual([]);
  });

  it('writes the head of a picked row with its required options', () => {
    const [playRow, addRow, listRow] = commandRows(music);
    const played = headDraft(music, playRow!.path, playRow!.options);
    expect(played).toEqual({ text: '/music play' + HEAD_GAP + 'query:' + VALUE_GAP, caret: ('/music play' + HEAD_GAP + 'query:' + VALUE_GAP).length });
    expect(headDraft(music, addRow!.path, addRow!.options).text).toBe('/music queue add' + HEAD_GAP + 'who:' + VALUE_GAP);
    expect(headDraft(music, listRow!.path, listRow!.options)).toEqual({ text: '/music queue list ', caret: 18 });
    expect(headDraft(play, [], play.options).text).toBe('/play' + HEAD_GAP + 'query:' + VALUE_GAP);
  });
});
