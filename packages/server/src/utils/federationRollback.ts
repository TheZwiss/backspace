/**
 * Permanent-failure callback registry for outbox events.
 *
 * When the federation worker observes a receiver-acknowledged terminal
 * rejection (4xx with a recognized reason like 'recipient_not_found'),
 * it invokes the registered callback for the eventType so the originating
 * instance can roll back any local state created at queue time.
 *
 * Callbacks are NEVER invoked on transient failures (5xx, network errors,
 * retry exhaustion). Only on receiver-acknowledged terminal rejections.
 *
 * Errors thrown by callbacks are logged but not re-thrown — rollback failure
 * must not prevent the outbox entry from being deleted.
 */
type PermanentFailureCallback = (messageId: string, reason: string) => void;

const callbacks = new Map<string, PermanentFailureCallback>();

export function registerPermanentFailureCallback(eventType: string, cb: PermanentFailureCallback): void {
  callbacks.set(eventType, cb);
}

export function invokePermanentFailureCallback(eventType: string, messageId: string, reason: string): void {
  const cb = callbacks.get(eventType);
  if (!cb) return;
  try {
    cb(messageId, reason);
  } catch (err) {
    console.error(
      `[federation-rollback] callback for ${eventType} (msg=${messageId}, reason=${reason}) threw:`,
      err,
    );
  }
}

/** Test-only: clear the registry between tests. */
export function _resetCallbacks(): void {
  callbacks.clear();
}
