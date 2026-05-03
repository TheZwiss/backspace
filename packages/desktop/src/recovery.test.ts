import { describe, it, expect, vi } from 'vitest';
import { RecoveryStateStore, type RecoveryState } from './recovery';

describe('RecoveryStateStore', () => {
  it('returns the initial state', () => {
    const store = new RecoveryStateStore();
    const s = store.get();
    expect(s.mode).toBe('normal');
    expect(s.reason).toBeNull();
    expect(s.updateState).toBe('idle');
    expect(s.updateVersion).toBeNull();
    expect(s.lastUpdateError).toBeNull();
    expect(s.lastCheckResult).toBeNull();
  });

  it('shallow-merges partial updates', () => {
    const store = new RecoveryStateStore();
    store.update({ updateState: 'checking' });
    expect(store.get().updateState).toBe('checking');
    expect(store.get().mode).toBe('normal');
    store.update({ updateVersion: '1.2.3' });
    expect(store.get().updateState).toBe('checking');
    expect(store.get().updateVersion).toBe('1.2.3');
  });

  it('fires listeners on every update', () => {
    const store = new RecoveryStateStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.update({ updateState: 'checking' });
    store.update({ updateState: 'idle' });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('subscribers receive the latest snapshot', () => {
    const store = new RecoveryStateStore();
    let received: RecoveryState | null = null;
    store.subscribe((s) => { received = s; });
    store.update({ updateState: 'downloaded', updateVersion: '2.0.0' });
    expect(received).not.toBeNull();
    expect(received!.updateState).toBe('downloaded');
    expect(received!.updateVersion).toBe('2.0.0');
  });

  it('unsubscribe stops callbacks', () => {
    const store = new RecoveryStateStore();
    const cb = vi.fn();
    const unsub = store.subscribe(cb);
    store.update({ updateState: 'checking' });
    unsub();
    store.update({ updateState: 'idle' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers all receive updates', () => {
    const store = new RecoveryStateStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.update({ updateState: 'checking' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('isInRecoveryMode is false initially, true after markRecoveryEntered, false after markRecoveryExited', () => {
    const store = new RecoveryStateStore();
    expect(store.isInRecoveryMode()).toBe(false);
    store.markRecoveryEntered();
    expect(store.isInRecoveryMode()).toBe(true);
    store.markRecoveryExited();
    expect(store.isInRecoveryMode()).toBe(false);
  });
});
