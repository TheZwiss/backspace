import type { Activity } from '@backspace/shared';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';

interface ActivityCardProps {
  activities: Activity[];
  compact?: boolean;
  fallbackCustomStatus?: string | null;
}

function formatElapsed(startMs: number): string {
  const elapsed = Date.now() - startMs;
  const minutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function ActivityIcon({ type }: { type: Activity['type'] }) {
  switch (type) {
    case 'playing':
      return <span className="text-[10px] text-accent-mint mr-1 font-medium">PLAYING</span>;
    case 'listening':
      return <span className="text-[10px] text-accent-sky mr-1 font-medium">LISTENING</span>;
    case 'watching':
      return <span className="text-[10px] text-accent-lavender mr-1 font-medium">WATCHING</span>;
    case 'streaming':
      return <span className="text-[8px] font-bold mr-1 px-1 py-px rounded bg-red-500/80 text-white leading-tight">LIVE</span>;
    default:
      return null;
  }
}

function CompactActivity({ activity }: { activity: Activity }) {
  const label = activity.type === 'custom'
    ? activity.name
    : activity.type === 'playing'
      ? `Playing ${activity.name}`
      : activity.type === 'listening'
        ? activity.details ?? activity.name
        : activity.type === 'watching'
          ? `Watching ${activity.name}`
          : activity.name;

  return (
    <div className="flex items-center text-[11px] leading-[1.3] text-txt-tertiary truncate">
      <ActivityIcon type={activity.type} />
      <span className="truncate">{label}</span>
    </div>
  );
}

function FullActivity({ activity }: { activity: Activity }) {
  if (activity.type === 'custom') {
    return (
      <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate">
        {activity.name}
      </div>
    );
  }

  const typeLabel = activity.type === 'playing' ? 'Playing'
    : activity.type === 'listening' ? 'Listening to'
    : activity.type === 'watching' ? 'Watching'
    : 'Streaming';

  return (
    <div className="mt-1.5 rounded-lg bg-surface-elevated p-2.5">
      <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wide mb-1.5">
        {typeLabel}
      </div>
      <div className="flex gap-2.5">
        {activity.assets?.largeImage && (
          <img
            src={activity.assets.largeImage}
            alt={activity.assets.largeText ?? activity.name}
            className="w-[50px] h-[50px] rounded-md object-cover flex-shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-txt-primary truncate">
            {activity.name}
          </div>
          {activity.details && (
            <div className="text-[11px] text-txt-secondary truncate">{activity.details}</div>
          )}
          {activity.state && (
            <div className="text-[11px] text-txt-tertiary truncate">{activity.state}</div>
          )}
          {activity.timestamps?.start && (
            <div className="text-[10px] text-txt-tertiary mt-0.5">
              {formatElapsed(activity.timestamps.start)} elapsed
            </div>
          )}
        </div>
        {activity.assets?.smallImage && (
          <img
            src={activity.assets.smallImage}
            alt={activity.assets.smallText ?? ''}
            className="w-5 h-5 rounded-full flex-shrink-0 self-start"
          />
        )}
      </div>
    </div>
  );
}

export function ActivityCard({ activities, compact = false, fallbackCustomStatus }: ActivityCardProps) {
  const primary = getPrimaryActivity(activities);

  if (!primary) {
    if (fallbackCustomStatus) {
      return <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate">{fallbackCustomStatus}</div>;
    }
    return null;
  }

  if (compact) {
    return <CompactActivity activity={primary} />;
  }

  return <FullActivity activity={primary} />;
}
