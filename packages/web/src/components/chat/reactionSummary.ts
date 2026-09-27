import type { TFunction } from 'i18next';
import type { Reaction, User } from '@backspace/shared';
import type { Formatters } from '../../i18n/formatters';
import { isSelf } from '../../utils/identity';

/**
 * The current user's own reaction. Reactions carry the reacting user, which
 * `isSelf` matches across the user's instance ids; a row without one (older
 * payloads) falls back to the local id.
 */
export function isOwnReaction(reaction: Reaction, currentUser: User | null): boolean {
  return reaction.user ? isSelf(reaction.user, currentUser) : reaction.userId === currentUser?.id;
}

/** Who reacted with one emoji, as the tooltip says it. */
export interface ReactorSummary {
  /** The current user is among the reactors. Always named first, as "You". */
  includesYou: boolean;
  /** Everyone else who is named, in the order they reacted. */
  names: string[];
  /** Reactors past the named ones. */
  others: number;
  /** Distinct reactors. */
  total: number;
}

/** People named before the rest become "N others"; "You" counts as one. */
const MAX_NAMED = 3;

/**
 * Summarizes the reactions for one emoji on one message.
 *
 * `isYou` and `nameOf` resolve identity at the call site, where the current
 * user and the cross-instance user views are known. A reactor is counted once
 * even if two rows name them (the current user seen under two of their
 * instance ids, for instance).
 */
export function summarizeReactors(
  reactions: readonly Reaction[],
  isYou: (reaction: Reaction) => boolean,
  nameOf: (reaction: Reaction) => string,
): ReactorSummary {
  let includesYou = false;
  const seen = new Set<string>();
  const others: Reaction[] = [];
  const ordered = [...reactions].sort((a, b) => a.createdAt - b.createdAt);
  for (const reaction of ordered) {
    if (isYou(reaction)) {
      includesYou = true;
      continue;
    }
    if (seen.has(reaction.userId)) continue;
    seen.add(reaction.userId);
    others.push(reaction);
  }
  const namedSlots = MAX_NAMED - (includesYou ? 1 : 0);
  return {
    includesYou,
    names: others.slice(0, namedSlots).map(nameOf),
    others: Math.max(0, others.length - namedSlots),
    total: others.length + (includesYou ? 1 : 0),
  };
}

/** The tooltip sentence, and where the names sit in it so they can be emphasized. */
export interface ReactionSentence {
  text: string;
  namesStart: number;
  namesLength: number;
}

function locate(text: string, part: string): ReactionSentence {
  const start = part ? text.indexOf(part) : -1;
  return start === -1
    ? { text, namesStart: 0, namesLength: 0 }
    : { text, namesStart: start, namesLength: part.length };
}

/**
 * "You, Mira, and 3 others reacted".
 *
 * Three catalog shapes, because the verb agrees with its subject in German
 * and Russian: only you, exactly one other person, and several people (the
 * list is joined by `formatList` from the formatters).
 */
export function reactionSentence(
  summary: ReactorSummary,
  t: TFunction<['chat', 'common']>,
  fmt: Pick<Formatters, 'formatList'>,
): ReactionSentence {
  const you = t('chat:message.reactions.you');
  if (summary.total <= 1 && summary.includesYou) {
    return locate(t('chat:message.reactions.bySelf'), you);
  }
  if (summary.total <= 1) {
    const name = summary.names[0] ?? t('common:states.unknown');
    return locate(t('chat:message.reactions.byOne', { name }), name);
  }
  const items = [
    ...(summary.includesYou ? [you] : []),
    ...summary.names,
    ...(summary.others > 0 ? [t('chat:message.reactions.others', { count: summary.others })] : []),
  ];
  const names = fmt.formatList(items);
  return locate(t('chat:message.reactions.byMany', { names }), names);
}
