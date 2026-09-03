import { describe, it, expect, vi } from 'vitest';
import {
  UpdateStatusStore,
  shouldPromptForUpdate,
  canInstallInPlace,
  statusVersion,
  type UpdateSnapshot,
  type UpdateStatus,
} from './updateStatus';

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-userdata' },
}));

function snap(partial: Partial<UpdateSnapshot>): UpdateSnapshot {
  return {
    capability: 'auto',
    dismissedVersion: null,
    status: { phase: 'idle' },
    ...partial,
  };
}

describe('statusVersion', () => {
  it('extracts the version from every phase that carries one', () => {
    expect(statusVersion({ phase: 'available', version: '1.0.4' })).toBe('1.0.4');
    expect(statusVersion({ phase: 'ready', version: '1.0.4' })).toBe('1.0.4');
    expect(statusVersion({ phase: 'downloading', version: '1.0.4', percent: 5, bytesPerSecond: 1 })).toBe('1.0.4');
    expect(statusVersion({ phase: 'failed', version: '1.0.4', message: 'x' })).toBe('1.0.4');
  });

  it('returns null for phases with no version', () => {
    expect(statusVersion({ phase: 'idle' })).toBeNull();
    expect(statusVersion({ phase: 'checking' })).toBeNull();
    expect(statusVersion({ phase: 'up-to-date', checkedAt: 1 })).toBeNull();
    expect(statusVersion({ phase: 'failed', version: null, message: 'x' })).toBeNull();
  });
});

describe('shouldPromptForUpdate', () => {
  it('prompts for an available, ready, or failed update', () => {
    expect(shouldPromptForUpdate(snap({ status: { phase: 'available', version: '1.0.4' } }))).toBe(true);
    expect(shouldPromptForUpdate(snap({ status: { phase: 'ready', version: '1.0.4' } }))).toBe(true);
    expect(shouldPromptForUpdate(snap({ status: { phase: 'failed', version: '1.0.4', message: 'x' } }))).toBe(true);
  });

  it('stays quiet for progress phases', () => {
    expect(shouldPromptForUpdate(snap({ status: { phase: 'idle' } }))).toBe(false);
    expect(shouldPromptForUpdate(snap({ status: { phase: 'checking' } }))).toBe(false);
    expect(shouldPromptForUpdate(snap({
      status: { phase: 'downloading', version: '1.0.4', percent: 40, bytesPerSecond: 1 },
    }))).toBe(false);
    expect(shouldPromptForUpdate(snap({ status: { phase: 'up-to-date', checkedAt: 1 } }))).toBe(false);
  });

  it('stays quiet for a dismissed version', () => {
    expect(shouldPromptForUpdate(snap({
      dismissedVersion: '1.0.4',
      status: { phase: 'available', version: '1.0.4' },
    }))).toBe(false);
  });

  it('still prompts for a version newer than the dismissed one', () => {
    expect(shouldPromptForUpdate(snap({
      dismissedVersion: '1.0.4',
      status: { phase: 'available', version: '1.0.5' },
    }))).toBe(true);
  });

  it('stays quiet for a failure that never learned a version', () => {
    expect(shouldPromptForUpdate(snap({
      status: { phase: 'failed', version: null, message: 'network unreachable' },
    }))).toBe(false);
  });
});

describe('canInstallInPlace', () => {
  it('is true only for a ready update on an auto-capable build', () => {
    expect(canInstallInPlace(snap({ capability: 'auto', status: { phase: 'ready', version: '1.0.4' } }))).toBe(true);
  });

  it('is false on a build that cannot install its own updates', () => {
    // The ad-hoc signed macOS case. This is what removes the dead Restart button.
    expect(canInstallInPlace(snap({ capability: 'manual', status: { phase: 'ready', version: '1.0.4' } }))).toBe(false);
  });

  it('is false for any phase other than ready', () => {
    expect(canInstallInPlace(snap({ capability: 'auto', status: { phase: 'available', version: '1.0.4' } }))).toBe(false);
    expect(canInstallInPlace(snap({ capability: 'auto', status: { phase: 'idle' } }))).toBe(false);
  });
});

describe('UpdateStatusStore', () => {
  it('starts idle and carries the injected ambient facts', () => {
    const store = new UpdateStatusStore('manual', '1.0.3');
    expect(store.get()).toEqual({
      capability: 'manual',
      dismissedVersion: '1.0.3',
      status: { phase: 'idle' },
    });
  });

  it('lets a later failure supersede an earlier ready state', () => {
    // The exact defect: "Update ready" outranked "Update failed" forever because
    // two independent flags were checked in render order.
    const store = new UpdateStatusStore('auto', null);
    store.setStatus({ phase: 'ready', version: '1.0.4' });
    store.setStatus({ phase: 'failed', version: '1.0.4', message: 'squirrel refused' });
    expect(store.get().status).toEqual({ phase: 'failed', version: '1.0.4', message: 'squirrel refused' });
  });

  it('notifies subscribers on every status change', () => {
    const store = new UpdateStatusStore('auto', null);
    const seen: UpdateStatus[] = [];
    store.subscribe((s) => seen.push(s.status));
    store.setStatus({ phase: 'checking' });
    store.setStatus({ phase: 'up-to-date', checkedAt: 42 });
    expect(seen).toEqual([{ phase: 'checking' }, { phase: 'up-to-date', checkedAt: 42 }]);
  });

  it('notifies subscribers when a dismissal is recorded', () => {
    const store = new UpdateStatusStore('manual', null);
    store.setStatus({ phase: 'available', version: '1.0.4' });
    const seen: (string | null)[] = [];
    store.subscribe((s) => seen.push(s.dismissedVersion));
    store.setDismissedVersion('1.0.4');
    expect(seen).toEqual(['1.0.4']);
    expect(shouldPromptForUpdate(store.get())).toBe(false);
  });

  it('stops notifying after unsubscribe', () => {
    const store = new UpdateStatusStore('auto', null);
    let calls = 0;
    const off = store.subscribe(() => { calls += 1; });
    store.setStatus({ phase: 'checking' });
    off();
    store.setStatus({ phase: 'idle' });
    expect(calls).toBe(1);
  });

  it('survives a throwing listener and still notifies the rest', () => {
    const store = new UpdateStatusStore('auto', null);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reached = false;
    store.subscribe(() => { throw new Error('bad listener'); });
    store.subscribe(() => { reached = true; });
    store.setStatus({ phase: 'checking' });
    expect(reached).toBe(true);
    errorSpy.mockRestore();
  });

  it('hands out a frozen snapshot', () => {
    const store = new UpdateStatusStore('auto', null);
    expect(Object.isFrozen(store.get())).toBe(true);
  });
});
