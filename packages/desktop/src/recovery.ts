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
  private state: RecoveryState = Object.freeze({ ...INITIAL_STATE }) as RecoveryState;
  private listeners = new Set<(s: RecoveryState) => void>();
  private inRecoveryMode = false;

  get(): Readonly<RecoveryState> {
    return this.state;
  }

  update(partial: Partial<RecoveryState>): void {
    this.state = Object.freeze({ ...this.state, ...partial }) as RecoveryState;
    // Snapshot before iterating: a listener can subscribe/unsubscribe others
    // (or itself) during notification without affecting the current notify pass.
    const snapshot = Array.from(this.listeners);
    for (const cb of snapshot) {
      try {
        cb(this.state);
      } catch (err) {
        console.error('[recovery] listener threw:', err);
      }
    }
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

export function extractErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}
