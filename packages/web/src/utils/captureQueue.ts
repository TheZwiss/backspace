/** Serialize source selection and capture so a later picker cannot steal an earlier pending selection. */
export class CaptureQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(
    isCurrent: () => boolean,
    capture: () => Promise<T>,
    discard: (value: T) => void,
  ): Promise<T | null> {
    const operation = this.tail.then(async (): Promise<T | null> => {
      if (!isCurrent()) return null;

      const value = await capture();
      if (!isCurrent()) {
        discard(value);
        return null;
      }
      return value;
    });

    // Keep the queue moving after a failure, while returning the original
    // rejection to the operation's caller.
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
