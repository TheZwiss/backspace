import type { MemberWithUser, Role, User } from '@backspace/shared';
import type { ChannelUser } from '../../utils/channelUser';

export type MentionOption =
  | { kind: 'user'; token: string; candidate: ChannelUser }
  | { kind: 'mass'; token: string; label: string; color?: string };

function userMatches(user: User, query: string): boolean {
  const q = query.toLowerCase();
  return (user.displayName ?? '').toLowerCase().includes(q) || user.username.toLowerCase().includes(q);
}

/** One candidate list drives both keyboard selection and the visible popover. */
export function mentionOptions(input: {
  query: string;
  candidates?: readonly ChannelUser[];
  members?: readonly MemberWithUser[];
  roles?: readonly Role[];
  canMentionMass?: boolean;
}): MentionOption[] {
  const query = input.query.toLowerCase();
  const mass: MentionOption[] = input.canMentionMass
    ? [
        ...['everyone', 'here']
          .filter((name) => name.includes(query))
          .map((name) => ({ kind: 'mass' as const, token: '@' + name, label: '@' + name })),
        ...(input.roles ?? [])
          .filter((role) => !role.isEveryone && role.name.toLowerCase().includes(query))
          .map((role) => ({
            kind: 'mass' as const,
            token: '<@&' + role.id + '>',
            label: '@' + role.name.replace(/^@/, ''),
            color: role.color,
          })),
      ]
    : [];

  let users: MentionOption[] = [];
  if (input.candidates) {
    users = input.candidates
      .filter((c) => userMatches(c.user, query))
      .map((c) => ({
        kind: 'user' as const,
        token: '<@' + c.userId + '>',
        candidate: c,
      }));
  } else if (input.members) {
    users = input.members
      .filter((m) => userMatches(m.user, query))
      .map((m) => ({
        kind: 'user' as const,
        token: '<@' + m.userId + '>',
        candidate: {
          userId: m.userId,
          user: m.user,
          member: m,
          nameColor: null,
        },
      }));
  }

  return [...mass, ...users].slice(0, 8);
}


