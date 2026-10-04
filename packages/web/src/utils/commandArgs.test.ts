import { describe, expect, it } from 'vitest';
import type { BotCommandListing, BotCommandOption } from '@backspace/shared';
import { parseCommandArgs, remainingOptions, suggestOptions } from './commandArgs';

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
  it('offers the optional options that are not written yet', () => {
    expect(remainingOptions(play, '/play query:x volume:3').map((o) => o.name)).toEqual(['loop']);
    expect(remainingOptions(play, '/play query:x').map((o) => o.name)).toEqual(['volume', 'loop']);
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
