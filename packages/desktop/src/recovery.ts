export type RecoveryReasonCode =
  | 'load-failed'
  | 'render-gone'
  | 'unresponsive'
  | 'renderer-stalled';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface RecoveryState {
  mode: 'normal' | 'recovery';
  reason: { code: RecoveryReasonCode; detail: string } | null;
  updateState: UpdateState;
  updateVersion: string | null;
  lastUpdateError: { message: string; code: string | null; at: number } | null;
  lastCheckResult: 'up-to-date' | 'failed' | null;
}

const INITIAL_STATE: RecoveryState = {
  mode: 'normal',
  reason: null,
  updateState: 'idle',
  updateVersion: null,
  lastUpdateError: null,
  lastCheckResult: null,
};

export class RecoveryStateStore {
  private state: RecoveryState = { ...INITIAL_STATE };
  private listeners = new Set<(s: RecoveryState) => void>();
  private inRecoveryMode = false;

  get(): Readonly<RecoveryState> {
    return this.state;
  }

  update(partial: Partial<RecoveryState>): void {
    this.state = { ...this.state, ...partial };
    for (const cb of this.listeners) cb(this.state);
  }

  subscribe(cb: (s: RecoveryState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  isInRecoveryMode(): boolean {
    return this.inRecoveryMode;
  }

  markRecoveryEntered(): void {
    this.inRecoveryMode = true;
  }

  markRecoveryExited(): void {
    this.inRecoveryMode = false;
  }
}

export const recoveryStore = new RecoveryStateStore();
