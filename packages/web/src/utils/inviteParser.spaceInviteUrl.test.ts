import { describe, it, expect } from 'vitest';
import { parseInviteInput, spaceInviteUrl } from './inviteParser';

describe('spaceInviteUrl', () => {
  it("points a home space's link at the page's own instance", () => {
    expect(spaceInviteUrl('', 'a3f1b2c4')).toBe(`${window.location.origin}/join/a3f1b2c4`);
  });

  it("points a remote space's link at the instance that issued the code", () => {
    expect(spaceInviteUrl('https://orbit.example', 'a3f1b2c4')).toBe('https://orbit.example/join/a3f1b2c4');
  });

  it('keeps the port of a remote instance', () => {
    expect(spaceInviteUrl('https://orbit.example:8443', 'a3f1b2c4')).toBe('https://orbit.example:8443/join/a3f1b2c4');
  });

  it('uses the public join route, never the API invite path', () => {
    expect(new URL(spaceInviteUrl('https://orbit.example', 'a3f1b2c4')).pathname).toBe('/join/a3f1b2c4');
  });

  it('builds a link the invite parser reads back as the same code and instance', () => {
    expect(parseInviteInput(spaceInviteUrl('https://orbit.example', 'a3f1b2c4')))
      .toEqual({ code: 'a3f1b2c4', origin: 'https://orbit.example' });
    expect(parseInviteInput(spaceInviteUrl('', 'a3f1b2c4'))).toEqual({ code: 'a3f1b2c4' });
  });
});
