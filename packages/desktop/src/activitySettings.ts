import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface ActivitySettings {
  enablePreemption: boolean;
}

export const DEFAULT_ACTIVITY_SETTINGS: ActivitySettings = {
  enablePreemption: false,
};

function getActivitySettingsPath(): string {
  return path.join(app.getPath('userData'), 'activity-settings.json');
}

export function loadActivitySettings(): ActivitySettings {
  try {
    const raw = fs.readFileSync(getActivitySettingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ActivitySettings>;
    return {
      enablePreemption:
        typeof parsed.enablePreemption === 'boolean'
          ? parsed.enablePreemption
          : DEFAULT_ACTIVITY_SETTINGS.enablePreemption,
    };
  } catch {
    return { ...DEFAULT_ACTIVITY_SETTINGS };
  }
}

/**
 * Validate a renderer-supplied settings patch. Only known keys with the right
 * type survive; null when nothing usable was sent.
 */
export function parseActivitySettingsUpdate(raw: unknown): Partial<ActivitySettings> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const update: Partial<ActivitySettings> = {};
  if (typeof obj.enablePreemption === 'boolean') update.enablePreemption = obj.enablePreemption;
  return Object.keys(update).length > 0 ? update : null;
}

export function saveActivitySettings(settings: ActivitySettings): void {
  try {
    fs.writeFileSync(getActivitySettingsPath(), JSON.stringify(settings));
  } catch (err) {
    console.warn('[ActivitySettings] Failed to save activity settings:', err);
  }
}
