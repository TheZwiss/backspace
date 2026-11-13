import { CallHistoryMessage } from './CallHistoryMessage';
import type { DmChannel, MessageWithUser } from '@backspace/shared';
import { parseDmSystemEvent } from '@backspace/shared/src/dmSystemEvents';
import { useTranslation } from 'react-i18next';
import { SpaceInviteCard } from './SpaceInviteCard';
import { useFormatters } from '../../i18n/formatters';
import { dmSystemActor, dmSystemActorName, dmSystemIcon, dmSystemText } from '../../utils/dmFormatters';

interface SystemMessageProps {
  message: MessageWithUser;
  /**
   * The enclosing DM channel, if the message belongs to one. Its roster gives
   * the actor's current name (`dmSystemActor`); without it, or when the actor
   * is not on it, the author the message carries is used.
   */
  dm?: Pick<DmChannel, 'members'> | null;
}

/**
 * Timeline row for a DM system message. The event is read by the same parser
 * and phrased by the same helpers as the sidebar preview (`dmFormatters.ts`,
 * "System Messages"), in the timeline's fuller form. A space invite renders
 * as its card; content this version does not know renders the generic label.
 *
 * Exported so unit tests can render it directly without mounting MessageList.
 */
export function SystemMessage({ message, dm }: SystemMessageProps) {
  // Subscribes the row to language changes; the text itself comes from
  // `dmSystemText`, which reads the same i18n instance.
  useTranslation(['dm']);
  const f = useFormatters();
  const event = parseDmSystemEvent(message.content);
  const actorName = dmSystemActorName(dmSystemActor(message, dm?.members));

  if (event?.event === 'call_history') return <CallHistoryMessage event={event} actorName={actorName} />;

  if (event?.event === 'space_invite') {
    return (
      <div className="px-4 py-1">
        <SpaceInviteCard payload={event} senderName={actorName} />
      </div>
    );
  }

  const icon = dmSystemIcon(event);
  return (
    <div className="flex items-center justify-center py-1 px-4 select-none">
      <span className="text-xs text-txt-tertiary">
        {icon && <span className="mr-1.5">{icon}</span>}
        {dmSystemText(event, actorName, 'timeline')}
        {event?.event === 'nudge' && (
          <time
            dateTime={new Date(message.createdAt).toISOString()}
            title={`${f.formatMediumDate(message.createdAt)} ${f.formatTime(message.createdAt, true)}`}
            className="ml-2 whitespace-nowrap tabular-nums text-ui-micro"
          >
            {f.formatTime(message.createdAt)}
          </time>
        )}
      </span>
    </div>
  );
}
