import { describe, it, expect } from 'vitest';
import { isHttpOrigin, parseDmSystemEvent, type DmSystemEvent } from '@backspace/shared/src/dmSystemEvents.js';
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

describe('the space invite origin check agrees with the URL standard', () => {
  /**
   * What `isHttpOrigin` claims: `new URL` accepts the value as http(s), and the
   * value is `scheme://host[:port]` with nothing after, in printable ASCII
   * or non-ASCII characters (URL would drop tabs and newlines and decode `%`,
   * so the stored value would not be what it parsed). A non-ASCII host is
   * accepted when URL's IDNA rules accept it.
   */
  function urlAcceptsOrigin(value: string): boolean {
    if (!/^https?:\/\/(?:[!-~]|\P{ASCII})*$/iu.test(value) || /[/?#@\\%]/.test(value.replace(/^https?:\/\//i, ''))) return false;
    if (/:$/.test(value) && !/\]$/.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  const corpus = [
    // Domains, ports and case.
    'https://home.test', 'http://home.test:3000', 'HTTPS://Home.Test', 'http://localhost:3000',
    'https://a_b.example', 'https://a-b.example.', 'https://a..b', 'https://.', 'http://x:0', 'http://x:65535',
    'http://x:65536', 'http://x:99999', 'http://x:00080', 'http://x:', 'http://x:8a', 'https://', 'https://:80',
    "https://a!$&'()*+,;=_~.b", 'https://a"b', 'https://a`b{c}', 'https://a<b', 'https://a^b', 'https://a|b',
    // IPv4, including the standard's hex, octal and short forms.
    'http://127.0.0.1:3000', 'http://1.2.3.4.', 'http://256.1.1.1', 'http://1.2.3.4.5', 'http://0x7f.1',
    'http://0x', 'http://010.0.0.1', 'http://09.0.0.1', 'http://4294967295', 'http://4294967296',
    'http://1.2.3', 'http://1.2.65536', 'http://1..2', 'http://a.1', 'http://1.a', 'http://0x1g',
    // IPv6.
    'http://[::1]:3000', 'https://[::1]', 'http://[::]', 'http://[2001:db8::8a2e:370:7334]', 'http://[1:2:3:4:5:6:7:8]',
    'http://[1:2:3:4:5:6:7::]', 'http://[1:2:3:4:5:6:7:8:9]', 'http://[1:2:3:4:5:6:7:8::]', 'http://[::ffff:192.0.2.1]',
    'http://[::ffff:192.0.2.256]', 'http://[::ffff:192.0.02.1]', 'http://[::1.2.3]', 'http://[1::2::3]', 'http://[:1]',
    'http://[1:]', 'http://[12345::]', 'http://[g::]', 'http://[]', 'http://[::1', 'http://[::1]x', 'http://[::1]:',
    'http://[1:2:3:4:5:6:1.2.3.4]', 'http://[1:2:3:4:5:6:7:1.2.3.4]', 'http://[::1.2.3.4]',
    // Not an origin, though URL parses some of them.
    'https://home.test/', 'https://home.test/path', 'https://home.test?q', 'https://home.test#f', 'https://u@home.test',
    'https://home.test\\x', 'https://home .test', 'https://home\t.test', 'https://h%6Fme.test', 'ftp://home.test',
    'javascript:alert(1)', 'https:home.test', ' https://home.test',
    // Non-ASCII hosts, which URL maps through IDNA.
    'https://bücher.example', 'https://bücher.example:8443', 'https://ex\u3002ample', 'https://a\u00a0b',
    'https://a\uff0fb', 'https://a\uff20b', 'https://a\uff05b', 'https://a\uff1a80', 'http://x:\uff18\uff10',
    'http://[::\uff11]',
  ];

  for (const value of corpus) {
    it(`${JSON.stringify(value)}: ${urlAcceptsOrigin(value) ? 'accepted' : 'refused'}`, () => {
      expect(isHttpOrigin(value)).toBe(urlAcceptsOrigin(value));
    });
  }

  it('keeps a space invite from an IPv6 origin, as a 1.7.0 sender writes it', () => {
    const event: DmSystemEvent = {
      event: 'space_invite', spaceId: 's1', spaceInstanceOrigin: 'http://[::1]:3000', inviteCode: 'abc',
      snapshot: { spaceName: 'Lounge', icon: null, avatarColor: 'sky', memberCount: 0, description: 'hi', instanceName: '' },
    };
    expect(parseDmSystemEvent(dmSystemContent(event))).toEqual(event);
  });
});
