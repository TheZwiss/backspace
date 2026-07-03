import * as path from 'node:path';

export interface UploadMetadata {
  snowflakeId?: string;
  userId?: string;
  originalName?: string;
  [k: string]: string | undefined;
}

/** Parse the comma-separated `Upload-Metadata` header into a flat object. */
export function parseUploadMetadata(raw: string | null | undefined): UploadMetadata {
  if (!raw) return {};
  const out: UploadMetadata = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [key, b64] = trimmed.split(' ');
    if (!key) continue;
    if (!b64) {
      // Boolean-style key (no value)
      continue;
    }
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      // Reject if base64 round-trip mismatches — protects against odd encodings
      if (Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') !==
          b64.replace(/=+$/, '')) continue;
      out[key] = decoded;
    } catch { /* ignore */ }
  }
  return out;
}

/** Extract a sanitized lowercase extension, stripped of path components. */
export function extractExtension(originalName: string): string {
  const base = path.basename(originalName);
  const ext = path.extname(base).toLowerCase();
  return ext;
}

/** Build the metadata object stored on tus uploads at PRE_CREATE. */
export function buildTusMetadata(input: {
  snowflakeId: string;
  userId: string;
  originalName: string;
}): UploadMetadata {
  return {
    snowflakeId: input.snowflakeId,
    userId: input.userId,
    originalName: input.originalName,
  };
}

/** True iff the supplied userId matches metadata.userId. Used in PRE_PATCH. */
export function isOwnerOfUpload(metadata: UploadMetadata, userId: string): boolean {
  return Boolean(metadata.userId) && metadata.userId === userId;
}
