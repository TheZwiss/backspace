import type { MemberWithUser, Role, User } from '@backspace/shared';

interface MentionPart { wire: string; text: string; mention: boolean; start: number; wireStart: number }
export function composerMentions(input: { value: string; members: MemberWithUser[]; roles: Role[]; users?: User[] }) {
  const parts: MentionPart[] = [];
  // Keep code literal, matching the message parser's backtick-code rules.
  const pattern = /```[\s\S]*?```|`[^`]+`|<@(&?)([a-zA-Z0-9_-]+)>|(?<![\w@])@(?:everyone|here)(?![\w-])/g;
  let wireEnd = 0;
  let displayEnd = 0;
  const append = (wire: string, text: string, mention: boolean) => {
    parts.push({ wire, text, mention, start: displayEnd, wireStart: wireEnd });
    wireEnd += wire.length;
    displayEnd += text.length;
  };
  for (const match of input.value.matchAll(pattern)) {
    append(input.value.slice(wireEnd, match.index), input.value.slice(wireEnd, match.index), false);
    const token = match[0];
    const member = match[2] && !match[1] ? input.members.find(m => m.userId === match[2]) : undefined;
    const role = match[1] ? input.roles.find(r => r.id === match[2]) : undefined;
    const user = member?.user ?? input.users?.find(user => user.id === match[2]);
    const name = role?.name ?? (user ? user.displayName ?? user.username : undefined);
    const text = name ? '@' + name.replace(/^@/, '') : token;
    append(token, text, !!name || token.startsWith('@'));
  }
  append(input.value.slice(wireEnd), input.value.slice(wireEnd), false);
  const text = parts.map(p => p.text).join('');
  const toWire = (position: number, end = false): number => {
    const part = parts.find(p => position >= p.start && position < p.start + p.text.length);
    if (!part) return input.value.length;
    const offset = position - part.start;
    return part.wireStart + (part.mention && offset > 0 ? (end ? part.wire.length : 0) : offset);
  };
  const toDisplay = (position: number): number => {
    const part = parts.find(p => position >= p.wireStart && position < p.wireStart + p.wire.length);
    return part ? part.start + (part.mention ? 0 : position - part.wireStart) : text.length;
  };
  // Edits touching a mention replace its whole token, never leave a corrupt ID.
  const replace = (change: { start: number; end: number; text: string }) => {
    const start = toWire(change.start);
    const end = toWire(change.end, true);
    return { value: input.value.slice(0, start) + change.text + input.value.slice(end), cursor: toDisplay(start) + change.text.length };
  };
  const update = (next: string, cursor = next.length) => {
    let start = 0;
    while (start < text.length && start < cursor && start < next.length && text[start] === next[start]) start++;
    let end = text.length;
    let nextEnd = next.length;
    while (end > start && nextEnd > start && text[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
    return replace({ start, end, text: next.slice(start, nextEnd) });
  };
  return { parts, text, toWire, toDisplay, replace, update };
}
export type ComposerMentions = ReturnType<typeof composerMentions>;
