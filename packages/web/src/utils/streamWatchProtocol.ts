/**
 * Wire formats for the screen-share messages on the LiveKit data channel.
 *
 * `stream_watch` announces a viewer has begun (or stopped) watching a screen
 * share. Sent only from explicit user-action sites (StreamTile click handlers);
 * the receiver maintains the streamer-side watcher set, keyed by the sharer's
 * LiveKit identity (see `streamWatchKey`).
 *
 * `stream_republish` is sent by a sharer just before it unpublishes its screen
 * share to publish the same capture again (a codec change). Viewers keep the
 * stream and subscribe the next publication instead of treating the unpublish
 * as the share ending. Clients that predate it ignore it: it matches neither
 * `stream_watch` nor `deafen`.
 */
export interface StreamWatchPayload {
  type: 'stream_watch';
  /**
   * The sharer's user id as the viewer's client lists it. Per instance, so it
   * only names the sharer on clients that list it under the same id. Kept for
   * sharers that predate `targetIdentity` and read nothing else.
   */
  target: string;
  /**
   * The sharer's LiveKit identity, the same string on every client in the
   * room. Optional: viewers that predate it send only `target`.
   */
  targetIdentity?: string;
  watching: boolean;
}

/** A sharer as the viewer's client lists it. */
export interface StreamWatchTarget {
  userId: string;
  identity: string;
}

export interface StreamRepublishPayload {
  type: 'stream_republish';
}

export function encodeStreamWatch(payload: StreamWatchPayload): Uint8Array<ArrayBuffer> {
  return encodeJson(payload);
}

/** The ping a viewer sends when it starts or stops watching `sharer`. */
export function streamWatchFor(sharer: StreamWatchTarget, watching: boolean): StreamWatchPayload {
  return { type: 'stream_watch', target: sharer.userId, targetIdentity: sharer.identity, watching };
}

/**
 * The watcher-set key a received ping belongs to: the sharer's LiveKit
 * identity. A ping from an older viewer carries only `target`, which is
 * resolved through the participants this client lists; when nobody is listed
 * under it (the viewer's client knows the sharer by an id this one does not)
 * the ping cannot be placed and is dropped (null).
 */
export function streamWatchKey(
  payload: StreamWatchPayload,
  participants: readonly StreamWatchTarget[],
): string | null {
  if (payload.targetIdentity !== undefined) return payload.targetIdentity;
  return participants.find((p) => p.userId === payload.target)?.identity ?? null;
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
    (v.targetIdentity === undefined || typeof v.targetIdentity === 'string') &&
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
