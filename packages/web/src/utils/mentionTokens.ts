/**
 * The one scan for `<@id>` mention tokens in message content.
 *
 * A token is a mention only outside code: fenced blocks (```` ``` ````) and
 * inline code spans (`` `...` ``) are matched first and kept as written. Every
 * client reader of mentions goes through this scan, so the rendered message
 * (`MarkdownRenderer`), the reply preview (`InlineMessageText`), the mention
 * highlight (`Message`) and the alert rule (`notificationFilters`) agree on
 * which tokens are mentions. The server's relay rewrite
 * (`server/src/utils/federationMentions.ts`) uses the same expression.
 */

/** Code spans (fenced, then inline) or a mention token. A new instance per scan, since the flag makes it stateful. */
function mentionScanner(): RegExp {
  return /(```[\s\S]*?```|`[^`]+`)|<@([a-zA-Z0-9_-]+)>/g;
}

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; userId: string };

/**
 * `content` cut into text and mention segments, in order. Code stays inside
 * text segments exactly as written. Empty text segments are left out, so
 * empty content gives an empty list.
 */
export function splitMentionTokens(content: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let textStart = 0;
  for (const match of content.matchAll(mentionScanner())) {
    const userId = match[2];
    if (userId === undefined) continue;
    const start = match.index;
    if (start > textStart) segments.push({ kind: 'text', text: content.slice(textStart, start) });
    segments.push({ kind: 'mention', userId });
    textStart = start + match[0].length;
  }
  if (textStart < content.length) segments.push({ kind: 'text', text: content.slice(textStart) });
  return segments;
}

/** `content` with each token outside code replaced by `replace(userId)`; code and other text unchanged. */
export function replaceMentionTokens(content: string, replace: (userId: string) => string): string {
  return content.replace(mentionScanner(), (whole: string, code: string | undefined, userId: string | undefined) => {
    if (code !== undefined || userId === undefined) return whole;
    return replace(userId);
  });
}

/** Whether `content` mentions any of `userIds` outside code. */
export function contentMentionsAny(content: string, userIds: ReadonlySet<string>): boolean {
  for (const match of content.matchAll(mentionScanner())) {
    const userId = match[2];
    if (userId !== undefined && userIds.has(userId)) return true;
  }
  return false;
}
