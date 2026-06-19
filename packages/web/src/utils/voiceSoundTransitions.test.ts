import { describe, it, expect } from 'vitest';
import { selectVoiceStateSound } from './voiceSoundTransitions';

describe('selectVoiceStateSound', () => {
  it('returns null when nothing changed', () => {
    expect(
      selectVoiceStateSound({ muted: false, deafened: false }, { muted: false, deafened: false }),
    ).toBeNull();
    expect(
      selectVoiceStateSound({ muted: true, deafened: false }, { muted: true, deafened: false }),
    ).toBeNull();
  });

  it('plays mute when only mute flips on', () => {
    expect(
      selectVoiceStateSound({ muted: false, deafened: false }, { muted: true, deafened: false }),
    ).toBe('mute');
  });

  it('plays unmute when only mute flips off', () => {
    expect(
      selectVoiceStateSound({ muted: true, deafened: false }, { muted: false, deafened: false }),
    ).toBe('unmute');
  });

  it('plays only deafen (not mute) when deafening also forces mute on', () => {
    // toggleDeafen sets { isMuted: true, isDeafened: true } atomically.
    expect(
      selectVoiceStateSound({ muted: false, deafened: false }, { muted: true, deafened: true }),
    ).toBe('deafen');
  });

  it('plays only undeafen (not unmute) when undeafening also clears mute', () => {
    // toggleDeafen sets { isMuted: false, isDeafened: false } atomically.
    expect(
      selectVoiceStateSound({ muted: true, deafened: true }, { muted: false, deafened: false }),
    ).toBe('undeafen');
  });

  it('plays deafen when deafening while already muted (mute unchanged)', () => {
    expect(
      selectVoiceStateSound({ muted: true, deafened: false }, { muted: true, deafened: true }),
    ).toBe('deafen');
  });

  it('plays undeafen when un-deafened but still muted (e.g. moderator space-mute persists)', () => {
    expect(
      selectVoiceStateSound({ muted: true, deafened: true }, { muted: true, deafened: false }),
    ).toBe('undeafen');
  });

  it('prioritizes the deafen cue when both states change in one tick', () => {
    expect(
      selectVoiceStateSound({ muted: false, deafened: true }, { muted: true, deafened: false }),
    ).toBe('undeafen');
  });
});
