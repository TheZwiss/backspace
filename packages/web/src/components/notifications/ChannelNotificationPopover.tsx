import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { useSpaceChannelLocation } from '../../hooks/useNotificationSettings';
import { NotificationSettingsControls } from './NotificationSettingsControls';

interface ChannelNotificationPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  channelId: string;
  channelName: string;
}

/**
 * The channel header bell's popover: a small floating `.glass` surface
 * (Aether Drift popover tier) with the channel's level and mute options.
 * The settings are those of the instance that hosts the channel's space,
 * found through the space-channel index; until that index names the channel
 * there is nothing to edit and the popover does not render.
 */
export function ChannelNotificationPopover({ open, onClose, anchorRef, channelId, channelName }: ChannelNotificationPopoverProps) {
  const { t } = useTranslation(['spaces']);
  const popoverRef = useRef<HTMLDivElement>(null);
  const location = useSpaceChannelLocation(channelId);
  const { style } = useFloatingPosition(anchorRef, popoverRef, {
    placement: 'bottom',
    offset: 8,
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      // The bell toggles the popover itself; closing here would reopen it.
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose, anchorRef]);

  // Focus the selected level on open, so the keyboard lands inside.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      popoverRef.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, channelId]);

  if (!open || !location) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t('spaces:notifications.channelTitle', { channel: channelName })}
      style={style}
      className="w-[300px] glass rounded-lg shadow-xl p-3 animate-fade-in"
    >
      <div className="px-1 pb-2 text-ui-body font-semibold text-txt-primary truncate">
        {t('spaces:notifications.channelTitle', { channel: channelName })}
      </div>
      <NotificationSettingsControls origin={location.origin} spaceId={location.spaceId} channelId={channelId} />
    </div>,
    document.body,
  );
}
