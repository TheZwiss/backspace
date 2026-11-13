import { Tooltip } from '../ui/Tooltip';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChannelNotificationPolicy } from '../../hooks/useNotificationSettings';
import { BellOffIcon } from './ChannelMutedIndicator';
import { ChannelNotificationPopover } from './ChannelNotificationPopover';

/**
 * The channel header's bell. Opens the channel's notification popover, and
 * shows a crossed-out bell while the channel is muted (its own mute or its
 * space's).
 */
export function ChannelNotificationButton({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { t } = useTranslation(['spaces']);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const policy = useChannelNotificationPolicy(channelId);
  const muted = policy?.muted === true;
  const close = useCallback(() => setOpen(false), []);

  // A popover left open belongs to the channel it was opened on.
  useEffect(() => {
    setOpen(false);
  }, [channelId]);

  return (
    <>
      <Tooltip content={muted ? `${t('spaces:main.notificationSettings')} (${t('spaces:notifications.mutedIndicator')})` : t('spaces:main.notificationSettings')} position="top"><button data-icon-motion="bell" aria-label={muted ? `${t('spaces:main.notificationSettings')} (${t('spaces:notifications.mutedIndicator')})` : t('spaces:main.notificationSettings')}
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`w-8 h-8 flex items-center justify-center transition-colors rounded-[6px] ${
          open ? 'text-txt-primary bg-interactive-active' : 'text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover'
        }`}

      >
        {muted ? (
          <BellOffIcon size={24} />
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
          </svg>
        )}
      </button></Tooltip>
      <ChannelNotificationPopover
        open={open}
        onClose={close}
        anchorRef={buttonRef}
        channelId={channelId}
        channelName={channelName}
      />
    </>
  );
}
