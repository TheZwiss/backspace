import { describe, it, expect } from 'vitest';
import { PermissionBits, permissionsToString } from './permissions';
import { isHiddenFromEveryone, withOverrideBits } from './overrideBits';

const VIEW = PermissionBits.VIEW_CHANNEL;
const SEND = PermissionBits.SEND_MESSAGES;
const REACT = PermissionBits.ADD_REACTIONS;

describe('withOverrideBits', () => {
  it('denies a bit and keeps every other bit of the row', () => {
    expect(withOverrideBits({ allow: REACT, deny: SEND }, VIEW, 'deny')).toEqual({ allow: REACT, deny: SEND | VIEW });
  });

  it('moves a bit from allow to deny and back', () => {
    expect(withOverrideBits({ allow: VIEW | REACT, deny: 0n }, VIEW, 'deny')).toEqual({ allow: REACT, deny: VIEW });
    expect(withOverrideBits({ allow: 0n, deny: VIEW | SEND }, VIEW, 'allow')).toEqual({ allow: VIEW, deny: SEND });
  });

  it('clears a bit to neutral and keeps the rest', () => {
    expect(withOverrideBits({ allow: 0n, deny: VIEW | SEND }, VIEW, 'neutral')).toEqual({ allow: 0n, deny: SEND });
  });

  it('answers null when the row would set nothing, which removes it', () => {
    expect(withOverrideBits({ allow: 0n, deny: VIEW }, VIEW, 'neutral')).toBeNull();
    expect(withOverrideBits(null, VIEW, 'neutral')).toBeNull();
  });

  it('starts a row where there is none', () => {
    expect(withOverrideBits(null, VIEW, 'deny')).toEqual({ allow: 0n, deny: VIEW });
  });
});

describe('isHiddenFromEveryone', () => {
  const row = (targetId: string, deny: bigint) => ({ targetType: 'role', targetId, allow: '0', deny: permissionsToString(deny) });

  it('is the View Channels deny on the @everyone override', () => {
    expect(isHiddenFromEveryone([row('space', VIEW | SEND)], 'space')).toBe(true);
    expect(isHiddenFromEveryone([row('space', SEND)], 'space')).toBe(false);
    expect(isHiddenFromEveryone([row('r-mod', VIEW)], 'space')).toBe(false);
    expect(isHiddenFromEveryone([], 'space')).toBe(false);
  });

  it('ignores a member override whose id happens to equal the space id', () => {
    expect(isHiddenFromEveryone([{ ...row('space', VIEW), targetType: 'member' }], 'space')).toBe(false);
  });
});
