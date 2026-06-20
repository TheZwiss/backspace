import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createSnapshot, pruneSnapshots, state } = vi.hoisted(() => ({
  createSnapshot: vi.fn(() => '/tmp/snap-scheduled.db'),
  pruneSnapshots: vi.fn(),
  state: { disabled: false },
}));

vi.mock('./backup.js', () => ({ createSnapshot, pruneSnapshots }));
vi.mock('../db/index.js', () => ({ getRawDb: () => ({}) }));
vi.mock('../config.js', () => ({
  config: { backup: { get disabled() { return state.disabled; }, intervalHours: 1 } },
}));

import { startBackupWorker, stopBackupWorker } from './backupWorker.js';

beforeEach(() => { vi.useFakeTimers(); createSnapshot.mockClear(); pruneSnapshots.mockClear(); state.disabled = false; });
afterEach(() => { stopBackupWorker(); vi.useRealTimers(); });

describe('backupWorker', () => {
  it('snapshots on each interval tick', () => {
    startBackupWorker();
    vi.advanceTimersByTime(60 * 60 * 1000); // 1h
    expect(createSnapshot).toHaveBeenCalledWith(expect.anything(), 'scheduled');
    expect(pruneSnapshots).toHaveBeenCalledOnce();
  });

  it('does nothing when disabled', () => {
    state.disabled = true;
    startBackupWorker();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(createSnapshot).not.toHaveBeenCalled();
  });
});
