import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDmTimestamp, formatDmPreview, formatDmSidebarPreview, formatDmHeaderName, formatDmInputLabel, isDeletedPartnerDm } from './dmFormatters';
import type { DmChannel, DmLastMessagePreview, User } from '@backspace/shared';

/** Build a local-time Date: new Date(year, month-1, day, hour, minute) as a timestamp. */
function localTs(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('formatDmTimestamp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows time for today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 16, 0)); // Apr 2 2026, 4:00 PM local

    const twoHoursAgo = localTs(2026, 4, 2, 14, 0); // Apr 2 2026, 2:00 PM local
    const result = formatDmTimestamp(twoHoursAgo);
    // Should be a time string like "2:00 PM" — not "Yesterday" or a date
    expect(result).not.toBe('Yesterday');
    expect(result).not.toMatch(/\d{4}/); // no year
    expect(result).toMatch(/\d{1,2}/); // has a number (hour)
  });

  it('shows "Yesterday" for yesterday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 16, 0)); // Apr 2 2026

    const yesterday = localTs(2026, 4, 1, 12, 0); // Apr 1 2026
    expect(formatDmTimestamp(yesterday)).toBe('Yesterday');
  });

  it('shows month and day for this year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 16, 0)); // Apr 2 2026

    const marchDate = localTs(2026, 3, 15, 12, 0); // Mar 15 2026
    const result = formatDmTimestamp(marchDate);
    expect(result).toMatch(/Mar\s+15/);
  });

  it('shows month, day and year for previous years', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 16, 0)); // Apr 2 2026

    const lastYear = localTs(2025, 12, 14, 12, 0); // Dec 14 2025
    const result = formatDmTimestamp(lastYear);
    expect(result).toMatch(/Dec\s+14/);
    expect(result).toMatch(/2025/);
  });

  it('handles midnight boundary correctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 0, 5)); // Apr 2 2026, 00:05 local

    const lastNight = localTs(2026, 4, 1, 23, 55); // Apr 1 2026, 23:55 local
    expect(formatDmTimestamp(lastNight)).toBe('Yesterday');
  });
});

describe('formatDmPreview', () => {
  it('returns null for null lastMessage', () => {
    expect(formatDmPreview(null)).toBeNull();
  });

  it('returns text content when no attachments', () => {
    expect(formatDmPreview({
      content: 'hello world',
    })).toBe('hello world');
  });

  it('returns text content when attachments array is empty', () => {
    expect(formatDmPreview({
      content: 'hello world', attachments: [],
    })).toBe('hello world');
  });

  it('shows image icon for image-only message', () => {
    expect(formatDmPreview({
      content: null,
      attachments: [{ type: 'image/png', filename: 'photo.png' }],
    })).toBe('📷 Image');
  });

  it('shows video icon for video-only message', () => {
    expect(formatDmPreview({
      content: null,
      attachments: [{ type: 'video/mp4', filename: 'clip.mp4' }],
    })).toBe('🎬 Video');
  });

  it('shows audio icon for audio-only message', () => {
    expect(formatDmPreview({
      content: null,
      attachments: [{ type: 'audio/mpeg', filename: 'song.mp3' }],
    })).toBe('🎵 Audio');
  });

  it('shows file icon with filename for other types', () => {
    expect(formatDmPreview({
      content: null,
      attachments: [{ type: 'application/pdf', filename: 'report.pdf' }],
    })).toBe('📎 report.pdf');
  });

  it('shows count for multiple attachments without text', () => {
    expect(formatDmPreview({
      content: null,
      attachments: [
        { type: 'image/png', filename: 'a.png' },
        { type: 'image/jpeg', filename: 'b.jpg' },
      ],
    })).toBe('📎 2 files');
  });

  it('appends image icon to text when text + image', () => {
    expect(formatDmPreview({
      content: 'check this out',
      attachments: [{ type: 'image/png', filename: 'photo.png' }],
    })).toBe('check this out 📷');
  });

  it('appends video icon to text when text + video', () => {
    expect(formatDmPreview({
      content: 'look at this',
      attachments: [{ type: 'video/webm', filename: 'vid.webm' }],
    })).toBe('look at this 🎬');
  });

  it('appends audio icon to text when text + audio', () => {
    expect(formatDmPreview({
      content: 'listen',
      attachments: [{ type: 'audio/ogg', filename: 'voice.ogg' }],
    })).toBe('listen 🎵');
  });

  it('appends file icon to text when text + file', () => {
    expect(formatDmPreview({
      content: 'here you go',
      attachments: [{ type: 'application/zip', filename: 'archive.zip' }],
    })).toBe('here you go 📎');
  });

  it('uses generic file icon for mixed attachment types with text', () => {
    expect(formatDmPreview({
      content: 'stuff',
      attachments: [
        { type: 'image/png', filename: 'a.png' },
        { type: 'application/pdf', filename: 'b.pdf' },
      ],
    })).toBe('stuff 📎');
  });

  it('returns null for message with no content and no attachments', () => {
    expect(formatDmPreview({
      content: null,
    })).toBeNull();
  });

  it('returns null for empty string content and no attachments', () => {
    expect(formatDmPreview({
      content: '',
    })).toBeNull();
  });

  // Compatibility with Attachment type (mimetype/originalName field names)
  it('works with mimetype and originalName fields (Attachment shape)', () => {
    expect(formatDmPreview({
      content: null,
      attachments: [{ mimetype: 'image/png', originalName: 'photo.png' }],
    })).toBe('📷 Image');
  });

  it('appends icon to text with mimetype/originalName fields', () => {
    expect(formatDmPreview({
      content: 'check this',
      attachments: [{ mimetype: 'video/mp4', originalName: 'clip.mp4' }],
    })).toBe('check this 🎬');
  });
});

// ─── System message previews — exercised via formatDmSidebarPreview ──────────

const actor: User = {
  id: 'U1',
  username: 'heidi',
  displayName: 'Heidi',
  avatarColor: 'mint',
  avatar: null,
  bio: null,
  banner: null,
  accentColor: null,
  homeUserId: null,
  homeInstance: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: 0,
  replicatedInstances: [],
};

function makeGroupDm(lastMessage: DmLastMessagePreview): Pick<DmChannel, 'lastMessage' | 'ownerId' | 'members'> {
  return {
    ownerId: 'U1', // makes it a group DM
    members: [actor],
    lastMessage,
  };
}

describe('formatDmSidebarPreview — name_changed system message', () => {
  it('happy path with newName → "<actor> renamed the group"', () => {
    const dm = makeGroupDm({
      type: 'system',
      userId: 'U1',
      content: JSON.stringify({ event: 'name_changed', oldName: null, newName: 'Cool Group' }),
      createdAt: 1,
    });
    expect(formatDmSidebarPreview(dm, { id: 'OTHER', username: 'other' })).toBe('Heidi renamed the group');
  });

  it('newName=null (cleared) → "<actor> cleared the group name"', () => {
    const dm = makeGroupDm({
      type: 'system',
      userId: 'U1',
      content: JSON.stringify({ event: 'name_changed', oldName: 'Old', newName: null }),
      createdAt: 1,
    });
    expect(formatDmSidebarPreview(dm, { id: 'OTHER', username: 'other' })).toBe('Heidi cleared the group name');
  });

  it('unresolvable actor → "Unknown renamed the group"', () => {
    const dm = makeGroupDm({
      type: 'system',
      userId: 'GHOST', // not in members roster
      content: JSON.stringify({ event: 'name_changed', oldName: null, newName: 'X' }),
      createdAt: 1,
    });
    expect(formatDmSidebarPreview(dm, { id: 'OTHER', username: 'other' })).toBe('Unknown renamed the group');
  });
});

// ─── formatDmHeaderName / formatDmInputLabel ──────────────────────────────────

function makeMember(id: string, fields: Partial<User> = {}): User {
  return {
    id,
    username: id.toLowerCase(),
    displayName: null,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    homeInstance: null,
    status: 'offline',
    customStatus: null,
    isAdmin: false,
    createdAt: 0,
    replicatedInstances: [],
    ...fields,
  };
}

function makeGroupDmFull(args: { name: string | null; otherMembers: User[]; ownerId?: string }): DmChannel {
  return {
    id: 'dm-1',
    ownerId: args.ownerId ?? 'OWNER',
    name: args.name,
    icon: null,
    members: [makeMember('SELF', { username: 'self' }), ...args.otherMembers],
    lastMessage: null,
    metadataUpdatedAt: 0,
  } as DmChannel;
}

function make1on1Dm(other: User): DmChannel {
  return {
    id: 'dm-1',
    ownerId: null,
    name: null,
    icon: null,
    members: [makeMember('SELF', { username: 'self' }), other],
    lastMessage: null,
    metadataUpdatedAt: 0,
  } as DmChannel;
}

const SELF = { id: 'SELF', username: 'self' };

describe('formatDmHeaderName', () => {
  it('group with `dm.name` set → returns dm.name verbatim', () => {
    const dm = makeGroupDmFull({
      name: 'Cool Group',
      otherMembers: [makeMember('A', { displayName: 'Alice' })],
    });
    expect(formatDmHeaderName(dm, SELF)).toBe('Cool Group');
  });

  it('group with whitespace-only dm.name → falls back to joined names', () => {
    const dm = makeGroupDmFull({
      name: '   ',
      otherMembers: [makeMember('A', { displayName: 'Alice' }), makeMember('B', { displayName: 'Bob' })],
    });
    expect(formatDmHeaderName(dm, SELF)).toBe('Alice, Bob');
  });

  it('group without a name → comma-joined member display names (self excluded)', () => {
    const dm = makeGroupDmFull({
      name: null,
      otherMembers: [
        makeMember('A', { displayName: 'Alice' }),
        makeMember('B', { displayName: 'Bob' }),
        makeMember('C', { displayName: 'Charlie' }),
      ],
    });
    expect(formatDmHeaderName(dm, SELF)).toBe('Alice, Bob, Charlie');
  });

  it('group with members lacking displayName → falls back to parseFederatedUsername base', () => {
    const dm = makeGroupDmFull({
      name: null,
      otherMembers: [makeMember('A', { username: 'alice@nova.ddns.net' })],
    });
    expect(formatDmHeaderName(dm, SELF)).toBe('alice');
  });

  it('group with only self → returns "Group" placeholder', () => {
    const dm = makeGroupDmFull({ name: null, otherMembers: [] });
    expect(formatDmHeaderName(dm, SELF)).toBe('Group');
  });

  it('1-on-1 → partner display name', () => {
    const dm = make1on1Dm(makeMember('A', { displayName: 'Alice' }));
    expect(formatDmHeaderName(dm, SELF)).toBe('Alice');
  });

  it('1-on-1 without displayName → username base', () => {
    const dm = make1on1Dm(makeMember('A', { username: 'alice@nova.ddns.net' }));
    expect(formatDmHeaderName(dm, SELF)).toBe('alice');
  });

  it('1-on-1 with no resolvable partner → "Direct Message"', () => {
    const dm: DmChannel = {
      id: 'dm-1', ownerId: null, name: null, icon: null,
      members: [makeMember('SELF', { username: 'self' })],
      lastMessage: null, metadataUpdatedAt: 0,
    } as DmChannel;
    expect(formatDmHeaderName(dm, SELF)).toBe('Direct Message');
  });
});

describe('formatDmInputLabel', () => {
  it('group with `dm.name` set → "#<name>"', () => {
    const dm = makeGroupDmFull({ name: 'Cool Group', otherMembers: [makeMember('A')] });
    expect(formatDmInputLabel(dm, SELF)).toBe('#Cool Group');
  });

  it('group without a name → "the group" (collapses joined-names form)', () => {
    // Regression: previously the placeholder showed
    // "Message #Alice, Bob, Charlie, Dave" which overflows the input.
    const dm = makeGroupDmFull({
      name: null,
      otherMembers: [
        makeMember('A', { displayName: 'Alice' }),
        makeMember('B', { displayName: 'Bob' }),
        makeMember('C', { displayName: 'Charlie' }),
        makeMember('D', { displayName: 'Dave' }),
      ],
    });
    expect(formatDmInputLabel(dm, SELF)).toBe('the group');
  });

  it('group with whitespace-only dm.name → "the group"', () => {
    const dm = makeGroupDmFull({ name: '   ', otherMembers: [makeMember('A')] });
    expect(formatDmInputLabel(dm, SELF)).toBe('the group');
  });

  it('1-on-1 → "@<partner>"', () => {
    const dm = make1on1Dm(makeMember('A', { displayName: 'Alice' }));
    expect(formatDmInputLabel(dm, SELF)).toBe('@Alice');
  });
});

describe('deleted 1-on-1 partner', () => {
  const me: User = { id: 'me', username: 'me', displayName: 'Me' } as User;
  const deleted: User = { id: 'x', username: 'Deleted User', displayName: null, isDeleted: true } as User;
  const dm = { id: 'd', ownerId: null, members: [me, deleted], createdAt: 0 } as unknown as DmChannel;

  it('header shows Deleted User', () => {
    expect(formatDmHeaderName(dm, me)).toBe('Deleted User');
  });
  it('input label points at Deleted User', () => {
    expect(formatDmInputLabel(dm, me)).toBe('@Deleted User');
  });
});

describe('formatDmSidebarPreview — icon_changed system message', () => {
  it('happy path → "<actor> updated the group icon"', () => {
    const dm = makeGroupDm({
      type: 'system',
      userId: 'U1',
      content: JSON.stringify({ event: 'icon_changed' }),
      createdAt: 1,
    });
    expect(formatDmSidebarPreview(dm, { id: 'OTHER', username: 'other' })).toBe('Heidi updated the group icon');
  });

  it('unresolvable actor → "Unknown updated the group icon"', () => {
    const dm = makeGroupDm({
      type: 'system',
      userId: 'GHOST',
      content: JSON.stringify({ event: 'icon_changed' }),
      createdAt: 1,
    });
    expect(formatDmSidebarPreview(dm, { id: 'OTHER', username: 'other' })).toBe('Unknown updated the group icon');
  });
});

describe('isDeletedPartnerDm', () => {
  const me = { id: 'me', username: 'me' } as User;
  it('true for a 1-on-1 whose only other member is deleted', () => {
    const dm = { ownerId: null, members: [me, { id: 'x', username: 'Deleted User', isDeleted: true } as User] };
    expect(isDeletedPartnerDm(dm as any, me)).toBe(true);
  });
  it('false for a live partner', () => {
    const dm = { ownerId: null, members: [me, { id: 'x', username: 'p', isDeleted: false } as User] };
    expect(isDeletedPartnerDm(dm as any, me)).toBe(false);
  });
  it('false for a group even with a deleted member', () => {
    const dm = { ownerId: 'me', members: [me, { id: 'x', isDeleted: true } as User] };
    expect(isDeletedPartnerDm(dm as any, me)).toBe(false);
  });
  it('false when there are zero other members', () => {
    expect(isDeletedPartnerDm({ ownerId: null, members: [me] } as any, me)).toBe(false);
  });
  it('false when others are mixed (one deleted, one live)', () => {
    const dm = { ownerId: null, members: [me, { id: 'x', isDeleted: true } as User, { id: 'y', isDeleted: false } as User] };
    expect(isDeletedPartnerDm(dm as any, me)).toBe(false);
  });
});
