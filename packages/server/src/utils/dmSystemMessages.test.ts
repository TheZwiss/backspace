import { describe, it, expect } from 'vitest';
import { parseDmSystemEvent, type DmSystemEvent } from '@backspace/shared/src/dmSystemEvents.js';
import { dmMessageEditRefusal, dmSystemContent, dmSystemName } from './dmSystemMessages.js';

describe('dmSystemName', () => {
  it('prefers the display name', () => {
    expect(dmSystemName({ displayName: 'Kai', username: 'kai@home.test' })).toBe('Kai');
  });

  it('falls back to the handle without the domain a replicated row carries', () => {
    expect(dmSystemName({ displayName: null, username: 'kai@home.test' })).toBe('kai');
    expect(dmSystemName({ displayName: '', username: 'kai' })).toBe('kai');
  });

  it('names a missing row Unknown', () => {
    expect(dmSystemName(undefined)).toBe('Unknown');
  });
});

describe('dmMessageEditRefusal', () => {
  it('refuses every edit of a system message, its author included', () => {
    expect(dmMessageEditRefusal({ userId: 'alice', type: 'system' }, 'alice')).toBe('system_message_immutable');
    expect(dmMessageEditRefusal({ userId: 'alice', type: 'system' }, 'bob')).toBe('system_message_immutable');
  });

  it('lets only the author edit any other message', () => {
    expect(dmMessageEditRefusal({ userId: 'alice', type: 'user' }, 'alice')).toBeNull();
    expect(dmMessageEditRefusal({ userId: 'alice', type: null }, 'bob')).toBe('not_message_author');
  });
});

describe('the content the server writes parses back to the same event', () => {
  const events: DmSystemEvent[] = [
    { event: 'member_added', targetUserId: 'u1', targetDisplayName: 'Kai' },
    { event: 'member_removed', targetUserId: 'u1', targetDisplayName: 'Kai', reason: 'kick' },
    { event: 'member_removed', targetUserId: 'u1', targetDisplayName: 'Kai', reason: 'leave' },
    { event: 'owner_changed', newOwnerId: 'u2', newOwnerDisplayName: 'Mira' },
    { event: 'name_changed', oldName: null, newName: 'Crew' },
    { event: 'name_changed', oldName: 'Crew', newName: null },
    { event: 'icon_changed' },
    {
      event: 'space_invite', spaceId: 's1', spaceInstanceOrigin: 'https://home.test', inviteCode: 'abc',
      snapshot: { spaceName: 'Lounge', icon: null, avatarColor: 'sky', memberCount: 0, description: 'hi', instanceName: '' },
    },
  ];
  for (const event of events) {
    it(`${event.event}${'reason' in event ? ` (${event.reason})` : ''}${'newName' in event ? ` (${String(event.newName)})` : ''}`, () => {
      expect(parseDmSystemEvent(dmSystemContent(event))).toEqual(event);
    });
  }

  it('parses no event from content it does not know', () => {
    expect(parseDmSystemEvent('not json')).toBeNull();
    expect(parseDmSystemEvent(JSON.stringify({ event: 'member_added', targetUserId: 'u1' }))).toBeNull();
    expect(parseDmSystemEvent(JSON.stringify({ event: 'call_started' }))).toBeNull();
    expect(parseDmSystemEvent(JSON.stringify(['member_added']))).toBeNull();
    expect(parseDmSystemEvent(null)).toBeNull();
  });
});
