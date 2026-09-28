import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useFormatters } from '../../i18n/formatters';
import { useChannelUser, type ChannelUser } from '../../utils/channelUser';
import { parseFederatedUsername } from '../../utils/identity';

interface TypingIndicatorProps {
  channelId: string;
}

/** How many typers are named; more than this is summarised. */
const MAX_NAMED_TYPERS = 2;

/**
 * Stand-ins for the names while the sentence is built. The translated line
 * and the language's list format place the names; each stand-in is then
 * replaced by its own element, so a long name truncates by width inside its
 * own box and the separators and the verb are never cut. Private-use code
 * points, so no catalog text or list separator can contain them.
 */
const NAME_SLOT_OPEN = '\uE000';
const NAME_SLOT_CLOSE = '\uE001';
const NAME_SLOT_SPLIT = /\uE000(\d+)\uE001/;

function nameSlot(index: number): string {
  return `${NAME_SLOT_OPEN}${index}${NAME_SLOT_CLOSE}`;
}

/**
 * The name shown for a typer: their display name as this channel knows them,
 * or, when the typer is not among the channel's people, the base of the
 * username the typing event carried (the event has nothing better).
 */
function typerName(resolved: ChannelUser | null, wireUsername: string): string {
  if (resolved) {
    return resolved.user.displayName ?? parseFederatedUsername(resolved.user.username).baseName;
  }
  return parseFederatedUsername(wireUsername).baseName;
}

/**
 * Renders `sentence` with each name stand-in replaced by the name in a
 * truncating box. The box keeps the full name in the DOM and in its title,
 * and takes pointer events so the title shows on hover (the line itself lets
 * clicks through to the messages under it).
 */
function renderNamedSentence(sentence: string, names: readonly string[]): React.ReactNode[] {
  // With one capture group, odd entries are the slot indices.
  return sentence.split(NAME_SLOT_SPLIT).map((part, i) => {
    if (i % 2 === 1) {
      const name = names[Number(part)] ?? '';
      return (
        <span key={i} title={name} className="min-w-0 truncate pointer-events-auto">
          {name}
        </span>
      );
    }
    return part ? <span key={i} className="shrink-0 whitespace-pre">{part}</span> : null;
  });
}

export function TypingIndicator({ channelId }: TypingIndicatorProps) {
  const { t } = useTranslation('chat');
  const fmt = useFormatters();
  const typingUsersRaw = useChatStore((s) => s.typingUsers.get(channelId));
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Filter out current user and expired entries
  const others = useMemo(() => {
    if (!typingUsersRaw || typingUsersRaw.length === 0) return [];
    const now = Date.now();
    return typingUsersRaw
      .filter(t => now - t.timestamp < 5000 && t.userId !== currentUserId);
  }, [typingUsersRaw, currentUserId]);

  // Only the named typers are resolved; a summary names nobody.
  const first = others.length <= MAX_NAMED_TYPERS ? others[0] : undefined;
  const second = others.length <= MAX_NAMED_TYPERS ? others[1] : undefined;
  const firstUser = useChannelUser(channelId, first?.userId ?? null);
  const secondUser = useChannelUser(channelId, second?.userId ?? null);

  if (others.length === 0) return null;

  let line: React.ReactNode;
  if (others.length > MAX_NAMED_TYPERS) {
    line = <span className="truncate">{t('composer.typing.several')}</span>;
  } else {
    const names: string[] = [];
    if (first) names.push(typerName(firstUser, first.username));
    if (second) names.push(typerName(secondUser, second.username));
    const sentence = t('composer.typing.named', {
      count: names.length,
      names: fmt.formatList(names.map((_, i) => nameSlot(i))),
    });
    line = renderNamedSentence(sentence, names);
  }

  return (
    <div className="absolute bottom-full left-1 right-1 desktop:left-4 desktop:right-4 mb-1 px-3 flex items-center text-[12px] text-txt-secondary font-medium select-none pointer-events-none animate-typing-in motion-reduce:animate-none">
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex shrink-0 gap-[2px] bg-surface-elevated/20 rounded-full px-2 py-1">
          <div className="w-[5px] h-[5px] bg-txt-message rounded-full animate-bounce" style={{ animationDelay: '0ms', animationDuration: '0.8s' }} />
          <div className="w-[5px] h-[5px] bg-txt-message rounded-full animate-bounce" style={{ animationDelay: '150ms', animationDuration: '0.8s' }} />
          <div className="w-[5px] h-[5px] bg-txt-message rounded-full animate-bounce" style={{ animationDelay: '300ms', animationDuration: '0.8s' }} />
        </div>
        <span data-typing-line className="flex min-w-0 max-w-[400px] font-bold whitespace-nowrap">
          {line}
        </span>
      </div>
    </div>
  );
}
