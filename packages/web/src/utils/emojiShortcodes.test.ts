import { beforeAll, describe, expect, it } from 'vitest';
import data from '@emoji-mart/data';
import type { EmojiMartData } from '@emoji-mart/data';
import {
  loadDiscordEmojiAliases,
  replaceEmojiShortcodes,
  replaceEmojiShortcodesInMarkdownSource,
} from './emojiShortcodes';
import { DISCORD_EMOJI_ALIASES } from './discordEmojiAliases';

beforeAll(async () => {
  await loadDiscordEmojiAliases();
});

describe('replaceEmojiShortcodes', () => {
  it('turns a known shortcode into its emoji', () => {
    expect(replaceEmojiShortcodes('on fire :heart_on_fire:')).toBe('on fire ❤️‍🔥');
  });

  it('resolves emoji-mart aliases', () => {
    expect(replaceEmojiShortcodes(':thumbsup:')).toBe('👍');
  });

  it('treats underscores and hyphens in a name as the same character', () => {
    // emoji-mart names flags `flag-va`; Discord and most users type `flag_va`.
    expect(replaceEmojiShortcodes(':flag_va: :flag-va:')).toBe('🇻🇦 🇻🇦');
    expect(replaceEmojiShortcodes(':woman_running:')).toBe(replaceEmojiShortcodes(':woman-running:'));
    expect(replaceEmojiShortcodes(':woman_running:')).not.toBe(':woman_running:');
  });

  it('applies a skin tone written the way the emoji picker shows it', () => {
    expect(replaceEmojiShortcodes(':+1::skin-tone-4:')).toBe('👍🏽');
    expect(replaceEmojiShortcodes(':+1::skin-tone-1:')).toBe('👍');
  });

  it('keeps the tone suffix as text when the emoji has no skin tones', () => {
    expect(replaceEmojiShortcodes(':heart_on_fire::skin-tone-3:')).toBe('❤️‍🔥:skin-tone-3:');
  });

  it('converts shortcodes written back to back', () => {
    expect(replaceEmojiShortcodes(':smile::smile:')).toBe('😄😄');
  });

  it('leaves unknown names as they were typed', () => {
    expect(replaceEmojiShortcodes('-Catholic :not_an_emoji: :orthodox_cross:')).toBe('-Catholic :not_an_emoji: ☦️');
  });

  it('does not touch clock times', () => {
    expect(replaceEmojiShortcodes('standup 09:30:00, back at 18:00')).toBe('standup 09:30:00, back at 18:00');
  });

  it('needs a word boundary: no letter or digit right before or after the colons', () => {
    // `:smile:` follows the digit 0, so it is part of `ratio:10:smile:`, not a shortcode.
    expect(replaceEmojiShortcodes('ratio:10:smile:')).toBe('ratio:10:smile:');
    expect(replaceEmojiShortcodes('a:smile:')).toBe('a:smile:');
    expect(replaceEmojiShortcodes(':smile:a')).toBe(':smile:a');
  });

  it.each([
    '2001:db8:a:b::1',
    'fe80::a:b:c:d',
    'user:id:42',
    'status:new:open',
    'PATH=/usr/bin:x:y',
    's[1:-1:2]',
    'score 1:100:2',
  ])('leaves %s as written', (text) => {
    expect(replaceEmojiShortcodes(text)).toBe(text);
  });

  it('still converts after punctuation, a space, another shortcode or CJK text', () => {
    expect(replaceEmojiShortcodes('est.:heart_on_fire:')).toBe('est.❤️‍🔥');
    expect(replaceEmojiShortcodes('-Catholic :flag_va:')).toBe('-Catholic 🇻🇦');
    expect(replaceEmojiShortcodes(':smile::smile:')).toBe('😄😄');
    expect(replaceEmojiShortcodes('你好:smile:世界')).toBe('你好😄世界');
  });

  it('never converts inside a URL', () => {
    expect(replaceEmojiShortcodes('https://x.com/:smile:/y')).toBe('https://x.com/:smile:/y');
    expect(replaceEmojiShortcodes('see www.x.com/:smile: now')).toBe('see www.x.com/:smile: now');
    expect(replaceEmojiShortcodes('https://x.com :smile:')).toBe('https://x.com 😄');
  });

  it('is case sensitive, like the names the picker shows', () => {
    expect(replaceEmojiShortcodes(':Smile:')).toBe(':Smile:');
  });

  it('returns text without colons unchanged', () => {
    const text = 'plain 💙 text with 👨‍👩‍👧‍👦 and 🇩🇪';
    expect(replaceEmojiShortcodes(text)).toBe(text);
  });
});

describe('Discord shortcode names', () => {
  it.each([
    ['cross', '✝️'],
    ['slight_smile', '🙂'],
    ['thinking', '🤔'],
    ['rofl', '🤣'],
    ['upside_down', '🙃'],
    ['hugging', '🤗'],
    ['nerd', '🤓'],
    ['rolling_eyes', '🙄'],
    ['skull_crossbones', '☠️'],
    ['cowboy', '🤠'],
    ['clown', '🤡'],
    ['facepalm', '🤦'],
    ['person_shrugging', '🤷'],
    ['regional_indicator_a', '🇦'],
    ['flag_white', '🏳️'],
    ['zipper_mouth', '🤐'],
    ['money_mouth', '🤑'],
  ])(':%s: renders %s', (name, emoji) => {
    expect(replaceEmojiShortcodes(`:${name}:`)).toBe(emoji);
  });

  it('maps _tone1.._tone5 to the lightest through the darkest skin tone', () => {
    expect(replaceEmojiShortcodes(':thumbsup_tone1: :thumbsup_tone3: :thumbsup_tone5:')).toBe('👍🏻 👍🏽 👍🏿');
    expect(replaceEmojiShortcodes(':person_shrugging_tone2:')).toBe('🤷🏼');
  });

  it('reads the long skin-tone spelling the same way', () => {
    expect(replaceEmojiShortcodes(':thumbsup_medium_skin_tone:')).toBe('👍🏽');
    expect(replaceEmojiShortcodes(':thumbsup_medium_light_skin_tone:')).toBe('👍🏼');
  });

  it('uses the listed emoji for toned names the general rule cannot build', () => {
    expect(replaceEmojiShortcodes(':couple_with_heart_man_man_tone1:')).toBe('👨🏻‍❤️‍👨🏻');
    expect(replaceEmojiShortcodes(':couple_with_heart_man_man_light_skin_tone:')).toBe('👨🏻‍❤️‍👨🏻');
  });

  it('leaves two-tone names as typed', () => {
    expect(replaceEmojiShortcodes(':handshake_tone1_tone2:')).toBe(':handshake_tone1_tone2:');
  });

  it('lets emoji-mart win where the two sets disagree', () => {
    // Discord's :snowman: is ⛄; the picker's is ☃️.
    expect(replaceEmojiShortcodes(':snowman:')).toBe('☃️');
  });

  it('lists no name that emoji-mart already resolves', () => {
    const mart = data as EmojiMartData;
    const martNames = new Set(
      [...Object.keys(mart.emojis), ...Object.keys(mart.aliases)].map((name) => name.replace(/-/g, '_')),
    );
    const shadowing = Object.keys(DISCORD_EMOJI_ALIASES).filter((name) => martNames.has(name));
    expect(shadowing).toEqual([]);
  });
});

describe('replaceEmojiShortcodesInMarkdownSource', () => {
  it('leaves code spans and fenced blocks as written', () => {
    expect(replaceEmojiShortcodesInMarkdownSource('`:smile:` and :smile:')).toBe('`:smile:` and 😄');
    expect(replaceEmojiShortcodesInMarkdownSource('```\n:smile:\n```')).toBe('```\n:smile:\n```');
  });

  it('leaves backslash-escaped colons as written', () => {
    expect(replaceEmojiShortcodesInMarkdownSource('\\:smile\\: :smile:')).toBe('\\:smile\\: 😄');
  });
});
