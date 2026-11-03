let pending: Promise<unknown> = Promise.resolve();

/** Source replacement and quality negotiation must never change the same sender concurrently. */
export function enqueueTrackUpdate<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
}
