import type { Activity, ActivityType } from './types.js';

export const ACTIVITY_LIMITS = {
  MAX_ACTIVITIES_PER_USER: 5,
  MAX_NAME_LENGTH: 128,
  MAX_DETAILS_LENGTH: 128,
  MAX_STATE_LENGTH: 128,
  MAX_ASSET_TEXT_LENGTH: 128,
  MAX_URL_LENGTH: 512,
} as const;

export const ACTIVITY_PRIORITY: Record<ActivityType, number> = {
  streaming: 5,
  playing: 4,
  listening: 3,
  watching: 2,
  custom: 1,
};

export function getPrimaryActivity(activities: Activity[]): Activity | null {
  if (!activities.length) return null;
  return activities.reduce((best, current) =>
    ACTIVITY_PRIORITY[current.type] > ACTIVITY_PRIORITY[best.type] ? current : best
  );
}
