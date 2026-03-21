// ─── Streaming Constants ─────────────────────────────────────────────────────

export const STANDARD_RESOLUTIONS = [540, 720, 1080, 1440, 2160] as const;
export type StandardResolution = (typeof STANDARD_RESOLUTIONS)[number];
export type Resolution = StandardResolution | 'native';

export const ALL_RESOLUTIONS: readonly Resolution[] = [...STANDARD_RESOLUTIONS, 'native'];

export const STANDARD_FRAMERATES = [30, 45, 60, 75, 90, 120] as const;
export type Framerate = (typeof STANDARD_FRAMERATES)[number];

export const WIDTH_MAP: Record<StandardResolution, number> = {
  540: 960,
  720: 1280,
  1080: 1920,
  1440: 2560,
  2160: 3840,
};

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  540: '540p',
  720: '720p',
  1080: '1080p',
  1440: '1440p',
  2160: '4K',
  native: 'Native',
};

export const HIGH_END_RESOLUTION_THRESHOLD = 1440;
export const HIGH_END_FRAMERATE_THRESHOLD = 75;
