import { describe, it, expect } from 'vitest';
import { shouldPlayMessageSound } from './notificationFilters';

describe('shouldPlayMessageSound', () => {
  const myIds = new Set(['local-snowflake', 'home-uid-42']);

  it('suppresses messages authored by self (local id)', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'local-snowflake',
        myIds,
        isDmChannel: true,
        content: 'hi',
        allChannels: false,
      }),
    ).toBe(false);
  });

  it('suppresses messages authored by self (home id)', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'home-uid-42',
        myIds,
        isDmChannel: true,
        content: 'hi',
        allChannels: false,
      }),
    ).toBe(false);
  });

  it('plays for DM messages from others', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'someone-else',
        myIds,
        isDmChannel: true,
        content: 'yo',
        allChannels: false,
      }),
    ).toBe(true);
  });

  it('suppresses non-DM, non-mention messages from others', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'someone-else',
        myIds,
        isDmChannel: false,
        content: 'general chatter',
        allChannels: false,
      }),
    ).toBe(false);
  });

  it('plays when content mentions me by local id', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'someone-else',
        myIds,
        isDmChannel: false,
        content: 'hey <@local-snowflake> look',
        allChannels: false,
      }),
    ).toBe(true);
  });

  it('plays when content mentions me by home id (federated)', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'someone-else',
        myIds,
        isDmChannel: false,
        content: 'cc <@home-uid-42>',
        allChannels: false,
      }),
    ).toBe(true);
  });

  it('does not play for mentions of someone else', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'someone-else',
        myIds,
        isDmChannel: false,
        content: 'pinging <@third-party>',
        allChannels: false,
      }),
    ).toBe(false);
  });

  it('plays for any non-self message when allChannels=true', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'someone-else',
        myIds,
        isDmChannel: false,
        content: 'general chatter',
        allChannels: true,
      }),
    ).toBe(true);
  });

  it('still suppresses self-authored even when allChannels=true', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'local-snowflake',
        myIds,
        isDmChannel: false,
        content: 'my own message',
        allChannels: true,
      }),
    ).toBe(false);
  });

  it('handles null content (attachment-only) gracefully', () => {
    expect(
      shouldPlayMessageSound({
        authorUserId: 'someone-else',
        myIds,
        isDmChannel: true,
        content: null,
        allChannels: false,
      }),
    ).toBe(true);
    expect(
      shouldPlayMessageSound({
        authorUserId: 'someone-else',
        myIds,
        isDmChannel: false,
        content: null,
        allChannels: false,
      }),
    ).toBe(false);
  });
});
