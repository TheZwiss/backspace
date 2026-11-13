import { describe, expect, it, vi } from 'vitest';
import { CaptureQueue } from './captureQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('CaptureQueue', () => {
  it('serializes complete captures and skips superseded queued work', async () => {
    const queue = new CaptureQueue();
    const firstCapture = deferred<string>();
    const events: string[] = [];
    let current = 'A';

    const first = queue.run(() => current === 'A', async () => {
      events.push('A:start');
      const value = await firstCapture.promise;
      events.push('A:end');
      return value;
    }, value => events.push(`A:discard:${value}`));
    await vi.waitFor(() => expect(events).toEqual(['A:start']));

    current = 'B';
    const second = queue.run(() => current === 'B', async () => {
      events.push('B:start');
      return 'B';
    }, value => events.push(`B:discard:${value}`));

    current = 'C';
    const third = queue.run(() => current === 'C', async () => {
      events.push('C:start');
      return 'C';
    }, value => events.push(`C:discard:${value}`));

    firstCapture.resolve('A');

    await expect(Promise.all([first, second, third])).resolves.toEqual([null, null, 'C']);
    expect(events).toEqual(['A:start', 'A:end', 'A:discard:A', 'C:start']);
  });

  it('discards an in-flight capture that becomes obsolete', async () => {
    const queue = new CaptureQueue();
    const captureResult = deferred<{ id: string }>();
    const discard = vi.fn();
    let current = true;
    const capture = vi.fn(() => captureResult.promise);
    const result = queue.run(() => current, capture, discard);

    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    current = false;
    const captured = { id: 'obsolete' };
    captureResult.resolve(captured);

    await expect(result).resolves.toBeNull();
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(captured);
  });

  it('propagates capture failures and allows the next operation to run', async () => {
    const queue = new CaptureQueue();
    const failure = new Error('picker failed');
    const nextCapture = vi.fn().mockResolvedValue('next');

    const first = queue.run(() => true, async () => { throw failure; }, vi.fn());
    const second = queue.run(() => true, nextCapture, vi.fn());

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe('next');
    expect(nextCapture).toHaveBeenCalledOnce();
  });

  it('skips queued work superseded before it starts without invoking capture', async () => {
    const queue = new CaptureQueue();
    const firstCapture = deferred<string>();
    const skippedCapture = vi.fn().mockResolvedValue('skipped');
    let current = true;
    const capture = vi.fn(() => firstCapture.promise);
    const first = queue.run(() => current, capture, vi.fn());
    const second = queue.run(() => false, skippedCapture, vi.fn());

    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    current = false;
    firstCapture.resolve('first');

    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(skippedCapture).not.toHaveBeenCalled();
  });
});
