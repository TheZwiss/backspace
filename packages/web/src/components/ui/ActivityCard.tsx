import type { Activity } from '@backspace/shared';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';

interface ActivityCardProps {
  activities: Activity[];
  fallbackCustomStatus?: string | null;
}

function formatElapsed(startMs: number): string {
  const elapsed = Date.now() - startMs;
  const minutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** Returns the accent border color class for an activity type */
export function getActivityAccentClass(type: Activity['type']): string {
  switch (type) {
    case 'playing': return 'border-l-accent-mint';
    case 'listening': return 'border-l-accent-sky';
    case 'watching': return 'border-l-accent-lavender';
    case 'streaming': return 'border-l-accent-rose';
    default: return '';
  }
}

/** Returns whether an activity should get the glass card row treatment */
export function hasRichActivity(activities: Activity[]): boolean {
  const primary = getPrimaryActivity(activities);
  return !!primary && primary.type !== 'custom';
}

/**
 * Renders activity details (app name + elapsed time).
 * The glass card wrapper is applied by the parent row container.
 */
export function ActivityCard({ activities, fallbackCustomStatus }: ActivityCardProps) {
  const primary = getPrimaryActivity(activities);

  if (!primary) {
    if (fallbackCustomStatus) {
      return <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate">{fallbackCustomStatus}</div>;
    }
    return null;
  }

  // Custom status — plain text, no card treatment
  if (primary.type === 'custom') {
    return <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate">{primary.name}</div>;
  }

  // Rich activity — app name + elapsed (card wrapper is on the parent row)
  return (
    <>
      <div className="text-[11px] leading-[1.3] text-txt-secondary truncate">
        {primary.name}
      </div>
      {primary.timestamps?.start && (
        <div className="text-[10px] leading-[1.3] text-txt-tertiary">
          {formatElapsed(primary.timestamps.start)} elapsed
        </div>
      )}
    </>
  );
}
