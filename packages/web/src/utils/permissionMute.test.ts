import { describe, expect, it } from 'vitest';
import { isPermissionMutedIn, isVoiceFlagIn, voiceFlagKey } from './permissionMute';

describe('isPermissionMutedIn', () => {
  it('a person is muted by the per-space key in whatever channel the row is', () => {
    const muted = new Set(['s1:u1']);
    expect(isPermissionMutedIn(muted, 's1', 'u1', 'c1')).toBe(true);
    expect(isPermissionMutedIn(muted, 's1', 'u1', null)).toBe(true);
    expect(isPermissionMutedIn(muted, 's1', 'u2', 'c1')).toBe(false);
  });

  it('a bot seat mute shows only in its own channel', () => {
    const muted = new Set(['s1:bot:cA']);
    expect(isPermissionMutedIn(muted, 's1', 'bot', 'cA')).toBe(true);
    expect(isPermissionMutedIn(muted, 's1', 'bot', 'cB')).toBe(false);
    expect(isPermissionMutedIn(muted, 's1', 'bot', null)).toBe(false);
  });

  it('without a space nothing is muted', () => {
    expect(isPermissionMutedIn(new Set(['undefined:u1']), undefined, 'u1', 'c1')).toBe(false);
  });
});

describe('isVoiceFlagIn (a moderator mute or deafen)', () => {
  it('a person is flagged in every channel of the space, a bot seat in its own channel only', () => {
    const flags = new Set([voiceFlagKey('s1', 'u1'), voiceFlagKey('s1', 'bot', 'cA')]);
    expect(isVoiceFlagIn(flags, 's1', 'u1', 'cB')).toBe(true);
    expect(isVoiceFlagIn(flags, 's1', 'bot', 'cA')).toBe(true);
    expect(isVoiceFlagIn(flags, 's1', 'bot', 'cB')).toBe(false);
    expect(isVoiceFlagIn(flags, 's2', 'u1', 'cB')).toBe(false);
  });

  it('keys a seat with its channel and a person without one', () => {
    expect(voiceFlagKey('s1', 'u1')).toBe('s1:u1');
    expect(voiceFlagKey('s1', 'bot', 'cA')).toBe('s1:bot:cA');
    expect(voiceFlagKey('s1', 'u1', null)).toBe('s1:u1');
  });
});
