import type { UserStatus } from '@backspace/shared';
import { useChangeSignal } from '../../hooks/useChangeSignal';

type Presence = Exclude<UserStatus, 'offline'> | 'offline' | null | undefined;

const PRESENCE_ORDER: readonly Presence[] = [null, 'online', 'idle', 'dnd', 'offline'];

/**
 * A compact, recognizable presence symbol shared by avatars and status pickers.
 * A live status change morphs the symbol in; the one it mounted with is drawn still.
 */
export function PresenceIndicator({
  status,
  size = 12,
  className = '',
}: {
  status: Presence;
  size?: number;
  className?: string;
}) {
  const change = useChangeSignal(PRESENCE_ORDER.indexOf(status ?? null));
  if (!status) return null;

  const colorClass = status === 'online'
    ? 'text-status-online'
    : status === 'idle'
      ? 'text-status-idle'
      : status === 'dnd'
        ? 'text-status-dnd'
        : 'text-status-offline';

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`shrink-0 transition-colors duration-200 ${colorClass} ${className}`}
    >
      <g key={change.generation} className={change.generation > 0 ? 'motion-presence-swap' : undefined}>
        {status === 'online' && <circle cx="12" cy="12" r="10" fill="currentColor" />}
        {status === 'idle' && <path fill="currentColor" d="M20.2 15.1A8.7 8.7 0 0 1 8.9 3.8 9.5 9.5 0 1 0 20.2 15.1Z" />}
        {status === 'dnd' && <>
          <circle cx="12" cy="12" r="10" fill="currentColor" />
          <path d="M7 12h10" fill="none" stroke="var(--color-surface-channel, #20202a)" strokeWidth="2.5" strokeLinecap="round" />
        </>}
        {status === 'offline' && <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="3" />}
      </g>
    </svg>
  );
}
