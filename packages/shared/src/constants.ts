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

// Hand-tuned VP9 screen share bitrates in kbps per resolution/framerate combo.
// All bitrate math operates in kbps; conversion to bps happens only at the WebRTC encoding boundary.
export const BITRATE_MATRIX_KBPS: Record<number, Record<number, number>> = {
  540:  { 30: 1500, 45: 2000, 60: 2500, 75: 2800, 90: 3200, 120: 4000 },
  720:  { 30: 3000, 45: 3500, 60: 4000, 75: 4500, 90: 5000, 120: 6000 },
  1080: { 30: 6000, 45: 7000, 60: 8000, 75: 9000, 90: 10000, 120: 12000 },
  1440: { 30: 10000, 45: 12000, 60: 14000, 75: 16000, 90: 18000, 120: 22000 },
  2160: { 30: 20000, 45: 24000, 60: 28000, 75: 32000, 90: 38000, 120: 45000 },
};

// ─── Group DM Constants ──────────────────────────────────────────────────────

export const GROUP_DM_NAME_MAX_LENGTH = 50;
export const GROUP_DM_NAME_MIN_LENGTH = 1;
export const GROUP_DM_ICON_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
export const GROUP_DM_ICON_MIME_PREFIX = 'image/';
