/**
 * Wire formats for the screen-share messages on the LiveKit data channel.
 *
 * `stream_watch` announces a viewer has begun (or stopped) watching a screen
 * share. Sent only from explicit user-action sites (StreamTile click handlers);
 * the receiver maintains the streamer-side watcher set.
 *
 * `stream_republish` is sent by a sharer just before it unpublishes its screen
 * share to publish the same capture again (a codec change). Viewers keep the
 * stream and subscribe the next publication instead of treating the unpublish
 * as the share ending. Clients that predate it ignore it: it matches neither
 * `stream_watch` nor `deafen`.
 */
export interface StreamWatchPayload {
  type: 'stream_watch';
  target: string;
  watching: boolean;
}

export interface StreamRepublishPayload {
  type: 'stream_republish';
}

export function encodeStreamWatch(payload: StreamWatchPayload): Uint8Array<ArrayBuffer> {
  return encodeJson(payload);
}

export function encodeStreamRepublish(): Uint8Array<ArrayBuffer> {
  const payload: StreamRepublishPayload = { type: 'stream_republish' };
  return encodeJson(payload);
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
  const parsed = decodeJson(payload);
  return isStreamWatchPayload(parsed) ? parsed : null;
}

/** True when the data-channel payload is a `stream_republish` announcement. */
export function isStreamRepublish(payload: Uint8Array): boolean {
  const parsed = decodeJson(payload);
  return typeof parsed === 'object' && parsed !== null
    && (parsed as Record<string, unknown>).type === 'stream_republish';
}

/**
 * Returns a `Uint8Array` explicitly backed by an `ArrayBuffer` rather than the
 * `ArrayBufferLike` that `TextEncoder.encode` is declared to return. LiveKit's
 * `publishData` accepts only non-shared buffers (`ReturnType<typeof
 * Uint8Array.from>`), so the copy through `Uint8Array.from` is what makes the
 * buffer kind provable at the type level. Payloads are a few dozen bytes.
 */
function encodeJson(payload: StreamWatchPayload | StreamRepublishPayload): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodeJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}
