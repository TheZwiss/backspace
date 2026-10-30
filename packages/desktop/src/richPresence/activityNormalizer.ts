import type { IpcActivityPayload, IpcActivityType, IpcAssets } from './protocol';

const LIMITS = {
  MAX_NAME_LENGTH: 128,
  MAX_DETAILS_LENGTH: 128,
  MAX_STATE_LENGTH: 128,
  MAX_ASSET_TEXT_LENGTH: 128,
  MAX_URL_LENGTH: 512,
} as const;

export function clampByCodepoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

export function resolveAssetUrl(value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (!/^https?:\/\//i.test(v)) return undefined;
  return v.length <= LIMITS.MAX_URL_LENGTH ? v : undefined;
}

const TYPE_BY_NUMBER: Record<number, IpcActivityType> = {
  0: 'playing',
  1: 'streaming',
  2: 'listening',
  3: 'watching',
};

function mapActivityType(value: unknown): IpcActivityType {
  if (typeof value === 'string') {
    if (value === 'playing' || value === 'listening' || value === 'watching' || value === 'streaming') return value;
  }
  if (typeof value === 'number' && TYPE_BY_NUMBER[value]) return TYPE_BY_NUMBER[value];
  return 'playing';
}

function clampOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = clampByCodepoints(value, max).trim();
  return s || undefined;
}

const toEpochMs = (value: number): number => (value > 0 && value < 1e12 ? value * 1000 : value);

function clampTimestamps(value: unknown): { start?: number; end?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = value as Record<string, unknown>;
  const start = typeof t.start === 'number' && Number.isFinite(t.start) ? toEpochMs(t.start) : undefined;
  const end = typeof t.end === 'number' && Number.isFinite(t.end) ? toEpochMs(t.end) : undefined;
  if (start === undefined && end === undefined) return undefined;
  return { start, end };
}

export function normalizeActivity(raw: Record<string, unknown>): IpcActivityPayload {
  const assetsRaw = (raw.assets && typeof raw.assets === 'object' ? raw.assets : {}) as Record<string, unknown>;

  const largeImage = typeof assetsRaw.large_image === 'string'
    ? resolveAssetUrl(assetsRaw.large_image)
    : typeof assetsRaw.largeImage === 'string' ? resolveAssetUrl(assetsRaw.largeImage) : undefined;
  const smallImage = typeof assetsRaw.small_image === 'string'
    ? resolveAssetUrl(assetsRaw.small_image)
    : typeof assetsRaw.smallImage === 'string' ? resolveAssetUrl(assetsRaw.smallImage) : undefined;
  const largeText = clampOptionalString(assetsRaw.large_text ?? assetsRaw.largeText, LIMITS.MAX_ASSET_TEXT_LENGTH);
  const smallText = clampOptionalString(assetsRaw.small_text ?? assetsRaw.smallText, LIMITS.MAX_ASSET_TEXT_LENGTH);

  const assets: IpcAssets | undefined =
    largeImage || largeText || smallImage || smallText
      ? { largeImage, largeText, smallImage, smallText }
      : undefined;

  return {
    type: mapActivityType(raw.type),
    name: clampOptionalString(raw.name, LIMITS.MAX_NAME_LENGTH),
    details: clampOptionalString(raw.details, LIMITS.MAX_DETAILS_LENGTH),
    state: clampOptionalString(raw.state, LIMITS.MAX_STATE_LENGTH),
    timestamps: clampTimestamps(raw.timestamps),
    assets,
  };
}
