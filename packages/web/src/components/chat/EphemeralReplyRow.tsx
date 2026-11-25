import { useTranslation } from 'react-i18next';
import type { EphemeralReply } from '@backspace/shared';
import { useFormatters } from '../../i18n/formatters';
import { Avatar } from '../ui/Avatar';
import { BotBadge } from '../ui/BotBadge';
import { MarkdownRenderer } from './MarkdownRenderer';
import { getChannelOrigin } from '../../stores/spaceStore';
import { useEphemeralReplyStore } from '../../stores/ephemeralReplyStore';
import { uploadUrlOn } from '../../utils/assetUrls';

/**
 * A bot's answer only the signed-in person sees (`ephemeral: true`), shown in
 * the timeline of the chat it was invoked in. It is not a stored message: no
 * reply, reaction, edit or menu, only a dismiss; a reload drops it too.
 */
export function EphemeralReplyRow({ reply, chatId }: { reply: EphemeralReply; chatId: string }) {
  const { t } = useTranslation(['chat']);
  const fmt = useFormatters();
  const dismiss = useEphemeralReplyStore((s) => s.dismiss);
  const name = reply.user.displayName || reply.user.username;
  const time = fmt.formatTime(reply.createdAt);

  return (
    <div
      role="article"
      aria-label={t('chat:ephemeral.rowLabel', { author: name, time })}
      data-ephemeral-reply={reply.id}
      className="relative flex gap-4 px-5 py-[3px] mt-[1.0625rem] bg-accent-primary/[0.06] border-l-2 border-l-accent-primary/50"
    >
      <div className="w-10 flex-shrink-0 mt-0.5">
        <Avatar src={uploadUrlOn(reply.user.avatar, getChannelOrigin(chatId))} name={name} size={40} avatarColor={reply.user.avatarColor} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="font-semibold text-[15px] leading-tight text-txt-primary">{name}</span>
          <BotBadge className="ml-1" />
          <span className="text-[11px] text-txt-tertiary leading-tight">{time}</span>
        </div>
        <div className="text-txt-message text-[15px] leading-[1.5] break-words whitespace-pre-wrap selection:bg-accent-primary/30">
          <MarkdownRenderer content={reply.content} channelId={chatId} />
        </div>
        <div className="flex items-center gap-1.5 mt-1 mb-1 text-[12px] text-txt-tertiary select-none">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>{t('chat:ephemeral.onlyYou')}</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => dismiss(chatId, reply.id)}
            className="text-txt-link hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 rounded-sm"
          >
            {t('chat:ephemeral.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
