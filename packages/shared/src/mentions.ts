// ─── Mention Tokens ─────────────────────────────────────────────────────────
// Wire syntax of the mentions a space message can carry. Shared so the server
// (which decides whether a mass mention may ping) and the client (which renders
// the tokens and decides whether a message alerts) read the text the same way.
//
//   <@userId>   one user
//   <@&roleId>  every member holding the role
//   @everyone   every member who can see the channel
//   @here       same audience as @everyone (Backspace has no "online only"
//               notion at alert time; the recipient's own settings decide)
//
// Tokens inside inline code or fenced code blocks are not mentions.

const CODE_SPANS = /```[\s\S]*?```|`[^`]+`/g;
const USER_MENTION = /<@([a-zA-Z0-9_-]+)>/g;
const ROLE_MENTION = /<@&([a-zA-Z0-9_-]+)>/g;
const EVERYONE_MENTION = /(^|[^\w@])@(everyone|here)(?![\w-])/;

export interface ParsedMentions {
  userIds: Set<string>;
  roleIds: Set<string>;
  everyone: boolean;
}

export function parseMentions(content: string | null | undefined): ParsedMentions {
  const result: ParsedMentions = { userIds: new Set(), roleIds: new Set(), everyone: false };
  if (!content) return result;
  const text = content.replace(CODE_SPANS, ' ');
  for (const m of text.matchAll(USER_MENTION)) result.userIds.add(m[1]!);
  for (const m of text.matchAll(ROLE_MENTION)) result.roleIds.add(m[1]!);
  result.everyone = EVERYONE_MENTION.test(text);
  return result;
}

/** Whether content carries a mass mention (`@everyone`/`@here` or a role), the kind gated by MENTION_EVERYONE. */
export function hasMassMention(content: string | null | undefined): boolean {
  const parsed = parseMentions(content);
  return parsed.everyone || parsed.roleIds.size > 0;
}
