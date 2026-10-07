import { describe, it, expect } from 'vitest';
import { isAlertAllowed, isMessageAlert } from './notificationFilters';

describe('isMessageAlert', () => {
  it('does not alert for my token inside code in a space channel', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId: 'local-snowflake',
        isDmChannel: false,
        content: 'the syntax is `<@local-snowflake>`',
        allChannels: false,
      }),
    ).toBe(false);
  });

  const myId = 'local-snowflake';

  it('suppresses messages the user wrote', () => {
    expect(
      isMessageAlert({
        authoredBySelf: true,
        myId,
        isDmChannel: true,
        content: 'hi',
        allChannels: false,
      }),
    ).toBe(false);
  });

  it('plays for DM messages from others', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: true,
        content: 'yo',
        allChannels: false,
      }),
    ).toBe(true);
  });

  it('suppresses non-DM, non-mention messages from others', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: 'general chatter',
        allChannels: false,
      }),
    ).toBe(false);
  });

  it('plays when content mentions my id on the channel\'s instance', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: 'hey <@local-snowflake> look',
        allChannels: false,
      }),
    ).toBe(true);
  });

  it('does not play for mentions of someone else', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: 'pinging <@third-party>',
        allChannels: false,
      }),
    ).toBe(false);
  });

  it('plays for any non-self message when allChannels=true', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: 'general chatter',
        allChannels: true,
      }),
    ).toBe(true);
  });

  it('still suppresses self-authored even when allChannels=true', () => {
    expect(
      isMessageAlert({
        authoredBySelf: true,
        myId,
        isDmChannel: false,
        content: 'my own message',
        allChannels: true,
      }),
    ).toBe(false);
  });

  it('handles null content (attachment-only) gracefully', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: true,
        content: null,
        allChannels: false,
      }),
    ).toBe(true);
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: null,
        allChannels: false,
      }),
    ).toBe(false);
  });
});

describe('isAlertAllowed (Do Not Disturb gate)', () => {
  it.each(['message', 'incoming_call'] as const)('suppresses %s alerts while the user is on dnd', (kind) => {
    expect(isAlertAllowed(kind, 'dnd')).toBe(false);
  });

  it.each([
    ['message', 'online'],
    ['message', 'idle'],
    ['incoming_call', 'online'],
    ['incoming_call', 'idle'],
  ] as const)('allows %s alerts while the user is %s', (kind, status) => {
    expect(isAlertAllowed(kind, status)).toBe(true);
  });

  it('allows alerts while the status is not known yet (no user loaded)', () => {
    expect(isAlertAllowed('message', null)).toBe(true);
    expect(isAlertAllowed('message', undefined)).toBe(true);
  });
});
