import type { KeyboardEvent, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useChannelPokeStore } from '../../stores/channelPokeStore';
import { menuPositionFor, useContextMenuStore, type ContextMenuItem } from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';
import { wsSend } from '../../hooks/useWebSocket';
import { resolveChannelUser } from '../../utils/channelUser';
import { spaceMemberName } from '../../utils/identity';
import { insertComposerMention } from './useComposerMention';

interface Options {
  /** The channel or DM the message is in. */
  channelId: string;
  /** The author's id on `origin`: the message's `userId`. */
  authorId: string;
  /** The instance that issued the channel's ids ('' is the page's own). */
  origin: string;
  isDm: boolean;
  /**
   * The viewer can write in the channel and the message is sent: not still
   * sending, SEND_MESSAGES in a space channel, a DM whose partner still has
   * an account.
   */
  canSend: boolean;
  /** The viewer wrote the message. */
  isAuthor: boolean;
}

/**
 * The right-click handler of a message author's avatar and name, also run for
 * the menu key or Shift+F10 on the focused name: a menu of what the viewer
 * can do with the author, kept apart from the message menu. The viewer's own
 * message has neither item.
 *
 * - Mention (`@name`): adds a `<@id>` token for the author to the channel's
 *   composer. The id is the message's `userId`, the channel origin's id, which
 *   is the id the mention picker inserts and the sent message's badge
 *   resolves. Offered when the author is one of the channel's people as
 *   `utils/channelUser` knows them, so the composer and the sent message can
 *   name them.
 * - Poke: space channels only, where the space's instance offered pokes in
 *   its `ready`.
 *
 * With neither item it does nothing, so the right click reaches the message
 * row and opens the message menu.
 */
export function useAuthorMenu({ channelId, authorId, origin, isDm, canSend, isAuthor }: Options) {
  const { t } = useTranslation('chat');
  const pokeSupported = useChannelPokeStore(s => s.hosts[origin] === true);
  return (event: MouseEvent | KeyboardEvent) => {
    if (!canSend || !channelId || isAuthor) return;
    const items: ContextMenuItem[] = [];
    const author = resolveChannelUser(channelId, authorId);
    if (author) {
      items.push({
        type: 'action', key: 'mention-author', label: '@' + spaceMemberName(author.member, author.user),
        onClick: () => insertComposerMention(channelId, authorId),
      });
    }
    if (!isDm && pokeSupported) {
      items.push({
        type: 'action', key: 'poke-author', label: t('poke.action'),
        onClick: () => {
          if (!wsSend({ type: 'channel_poke', channelId, targetUserId: authorId }, origin)) {
            useUIStore.getState().addToast(t('poke.disconnected'), 'warning');
          }
        },
      });
    }
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    useContextMenuStore.getState().open(menuPositionFor(event), items);
  };
}
