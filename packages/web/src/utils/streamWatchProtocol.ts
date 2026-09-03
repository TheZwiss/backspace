/**
 * Wire format for the LiveKit data-channel ping that announces a viewer
 * has begun (or stopped) watching a screen share. Sent only from explicit
 * user-action sites (StreamTile click handlers); receiver maintains the
 * streamer-side watcher set.
 */
export interface StreamWatchPayload {
  type: 'stream_watch';
  target: string;
  watching: boolean;
}

/**
 * Returns a `Uint8Array` explicitly backed by an `ArrayBuffer` rather than the
 * `ArrayBufferLike` that `TextEncoder.encode` is declared to return. LiveKit's
 * `publishData` accepts only non-shared buffers (`ReturnType<typeof
 * Uint8Array.from>`), so the copy through `Uint8Array.from` is what makes the
 * buffer kind provable at the type level. Payloads are a few dozen bytes.
 */
export function encodeStreamWatch(payload: StreamWatchPayload): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(payload)));
}

export function isStreamWatchPayload(value: unknown): value is StreamWatchPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 'stream_watch' &&
    typeof v.target === 'string' &&
    typeof v.watching === 'boolean'
  );
}

export function parseStreamWatch(payload: Uint8Array): StreamWatchPayload | null {
  try {
    const text = new TextDecoder().decode(payload);
    const parsed: unknown = JSON.parse(text);
    return isStreamWatchPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
