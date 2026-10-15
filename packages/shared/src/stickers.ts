import { isVisibleSingleLine } from './constants.js';

/** Namespaced values reuse message/reaction transport without colliding with native emoji. */
export const STICKER_PREFIX = 'sticker:';
export const DEFAULT_MAX_STICKER_BYTES = 5 * 1024 * 1024;
export const MAX_STICKER_BYTES = DEFAULT_MAX_STICKER_BYTES;
/** Longest collection name, after trimming. */
export const MAX_STICKER_NAME_LENGTH = 100;
/** Most stickers one account keeps in its collection. */
export const MAX_PERSONAL_STICKERS = 200;
/** Most images one upload form sends; the per-account upload rate allows a full batch in one minute. */
export const MAX_STICKER_BATCH = 20;
/** Uploads one account may send per minute. */
export const STICKER_UPLOADS_PER_MINUTE = 30;
export const STICKER_ID_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The form a collection name is stored in, or `undefined` when the value is
 * not one. A name is trimmed and refused when it trims to nothing, is longer
 * than MAX_STICKER_NAME_LENGTH, or fails the rule nicknames follow (control
 * characters, line breaks, bidirectional controls, nothing visible). The
 * server applies it on upload, collect and rename; the rename dialog applies
 * it before sending.
 */
export function normalizeStickerName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STICKER_NAME_LENGTH) return undefined;
  return isVisibleSingleLine(trimmed) ? trimmed : undefined;
}

export interface PersonalSticker {
  id: string;
  name: string;
  token: string;
}

/**
 * Only canonical HTTP image endpoints are renderable, never markup or data URLs.
 * WHATWG URL is available in both supported Node and browser runtimes.
 */
export function stickerUrl(value: string): string | null {
  if (!value.startsWith(STICKER_PREFIX)) return null;
  const candidate = value.slice(STICKER_PREFIX.length);
  try {
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.search || url.hash || !/^\/api\/stickers\/assets\/[a-f0-9]{64}\.webp$/.test(url.pathname)) return null;
    return url.href === candidate ? candidate : null;
  } catch {
    return null;
  }
}

/** The asset id (SHA-256 of the stored WebP) a sticker token names, or null when the value is not a sticker. */
export function stickerIdOf(value: string): string | null {
  const url = stickerUrl(value);
  if (!url) return null;
  return /\/api\/stickers\/assets\/([a-f0-9]{64})\.webp$/.exec(url)?.[1] ?? null;
}

/** Longest sticker pack name. */
export const MAX_STICKER_PACK_NAME_LENGTH = 100;

/** Longest sticker pack description. */
export const MAX_STICKER_PACK_DESC_LENGTH = 500;
/** Maximum number of stickers per sticker pack. */
export const MAX_STICKERS_PER_PACK = 100;

export type StickerPackOriginType = 'source' | 'replica';
export type StickerPackStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'deleted'
  | 'active'
  | 'disabled'
  | 'blocked';

export interface StickerPackSummary {
  id: string;
  name: string;
  description: string | null;
  creatorId: string | null;
  creatorName: string | null;
  coverAssetId: string | null;
  coverUrl: string | null;
  originType: StickerPackOriginType;
  sourceInstance: string | null;
  sourcePackId: string | null;
  currentVersion: number;
  status: StickerPackStatus;
  itemCount: number;
  isInstalled?: boolean;
  reviewNotes?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface StickerPackItem {
  id: string;
  packId: string;
  versionId: string;
  assetId: string;
  name: string;
  token: string;
  sortOrder: number;
  status: 'active' | 'deleted';
  createdAt: number;
}

export interface StickerPackDetail extends StickerPackSummary {
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  items: StickerPackItem[];
}

export interface StickerPeerPolicy {
  id: string;
  peerOrigin: string;
  policy: 'allow' | 'block';
  autoSync: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Resolves a sticker asset URL to a local origin endpoint if the asset is known or local,
 * otherwise falls back to the canonical token URL.
 */
export function resolveStickerAssetUrl(token: string, localOrigin?: string): string | null {
  const assetId = stickerIdOf(token);
  if (assetId && localOrigin) {
    let origin = localOrigin;
    while (origin.endsWith('/')) {
      origin = origin.slice(0, -1);
    }
    return `${origin}/api/stickers/assets/${assetId}.webp`;
  }
  return stickerUrl(token);
}

/**
 * Returns the preview / thumbnail URL for a sticker token or asset URL, appending ?preview=1.
 */
export function stickerPreviewUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = stickerUrl(value) || (value.startsWith('http') && value.includes('/api/stickers/assets/') ? value : null);
  if (!url) return null;
  return `${url}${url.includes('?') ? '&' : '?'}preview=1`;
}

/**
 * Resolves a sticker asset preview URL to a local origin endpoint if localOrigin is provided,
 * otherwise returns the preview URL from the canonical token URL.
 */
export function resolveStickerPreviewUrl(token: string, localOrigin?: string): string | null {
  const url = resolveStickerAssetUrl(token, localOrigin);
  if (!url) return null;
  return `${url}${url.includes('?') ? '&' : '?'}preview=1`;
}

