import { describe, it, expect } from 'vitest';
import { activeHomeNavItem } from './homeNav';

describe('activeHomeNavItem', () => {
  it('selects Explore on /explore', () => {
    expect(activeHomeNavItem('/explore', null)).toBe('explore');
  });

  it('selects Backspace on /backspace', () => {
    expect(activeHomeNavItem('/backspace', null)).toBe('backspace');
  });

  it('selects Friends on the DM home with no channel open', () => {
    expect(activeHomeNavItem('/channels/@me', null)).toBe('friends');
  });

  it('selects nothing while a DM is open', () => {
    expect(activeHomeNavItem('/channels/@me/dm-1', 'dm-1')).toBeNull();
  });

  it('selects nothing in a space channel', () => {
    expect(activeHomeNavItem('/channels/space-1/channel-1', 'channel-1')).toBeNull();
  });

  it('keeps the page items selected even when a stale channel id lingers', () => {
    expect(activeHomeNavItem('/explore', 'channel-1')).toBe('explore');
    expect(activeHomeNavItem('/backspace', 'channel-1')).toBe('backspace');
  });

  it('does not treat a path that only starts with a page name as that page', () => {
    expect(activeHomeNavItem('/backspace-old', null)).toBe('friends');
    expect(activeHomeNavItem('/explorer', null)).toBe('friends');
  });
});
