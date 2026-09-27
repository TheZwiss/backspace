import { describe, expect, it } from 'vitest';
import { replaceEmojiShortcodes } from './emojiShortcodes';

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
    expect(replaceEmojiShortcodes('-Catholic :cross: :orthodox_cross:')).toBe('-Catholic :cross: ☦️');
  });

  it('does not touch clock times', () => {
    expect(replaceEmojiShortcodes('standup 09:30:00, back at 18:00')).toBe('standup 09:30:00, back at 18:00');
  });

  it('finds a shortcode right after a colon that did not start one', () => {
    expect(replaceEmojiShortcodes('ratio:10:smile:')).toBe('ratio:10😄');
  });

  it('is case sensitive, like the names the picker shows', () => {
    expect(replaceEmojiShortcodes(':Smile:')).toBe(':Smile:');
  });

  it('returns text without colons unchanged', () => {
    const text = 'plain 💙 text with 👨‍👩‍👧‍👦 and 🇩🇪';
    expect(replaceEmojiShortcodes(text)).toBe(text);
  });
});
