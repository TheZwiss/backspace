/**
 * Cross-tab record of which tabs have a voice session, built on the Web Locks
 * API. Every tab with a session holds the shared lock; work that must not run
 * under any tab's session (swapping the service worker, which deletes the old
 * build's precache) takes the exclusive lock, so it waits until no tab holds
 * the shared one.
 *
 * Without `navigator.locks` both functions degrade to the calling tab alone:
 * nothing is held, and the task runs as soon as it is asked for.
 */

const VOICE_SESSION_LOCK = 'backspace-voice-session';

function lockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.locks ?? null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Takes the shared voice-session lock for this tab and keeps it until the
 * returned function is called, which releases it (or withdraws the request if
 * it is still queued). Returns null when the Web Locks API is unavailable.
 */
export function holdVoiceSessionLock(): (() => void) | null {
  const locks = lockManager();
  if (!locks) return null;
  const controller = new AbortController();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  locks
    .request(VOICE_SESSION_LOCK, { mode: 'shared', signal: controller.signal }, () => held)
    .catch((error: unknown) => {
      if (!isAbortError(error)) console.warn('[voiceSessionLock] Shared lock request failed', error);
    });
  return () => {
    controller.abort();
    release();
  };
}

type ExclusiveOutcome =
  | { kind: 'ran' }
  | { kind: 'yielded' }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: unknown };

/**
 * Runs `task` while holding the exclusive voice-session lock, which is only
 * granted when no tab holds the shared lock. Resolves true once the task has
 * run, false if `signal` aborted first. Rejects only if `task` itself throws.
 *
 * Lock requests are granted in order, so a tab that starts a session while
 * this request is queued has its shared request queued behind it and does not
 * hold the lock yet. The task therefore also yields to any shared request
 * still pending when the exclusive lock is granted, and queues again behind it.
 *
 * If the lock manager itself fails, the task runs anyway under the calling
 * tab's own check, the same as without the Web Locks API.
 */
export async function runWhenNoVoiceSession(
  task: () => Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;

  const locks = lockManager();
  if (!locks) {
    await task();
    return true;
  }

  while (!signal.aborted) {
    let outcome: ExclusiveOutcome;
    try {
      outcome = await locks.request(
        VOICE_SESSION_LOCK,
        { mode: 'exclusive', signal },
        async (): Promise<ExclusiveOutcome> => {
          const { pending = [] } = await locks.query();
          if (signal.aborted) return { kind: 'aborted' };
          if (pending.some((request) => request.name === VOICE_SESSION_LOCK && request.mode === 'shared')) {
            return { kind: 'yielded' };
          }
          try {
            await task();
          } catch (error) {
            return { kind: 'failed', error };
          }
          return { kind: 'ran' };
        },
      );
    } catch (error) {
      if (isAbortError(error)) return false;
      console.warn('[voiceSessionLock] Lock manager failed, applying without the cross-tab check', error);
      if (signal.aborted) return false;
      await task();
      return true;
    }
    if (outcome.kind === 'ran') return true;
    if (outcome.kind === 'aborted') return false;
    if (outcome.kind === 'failed') throw outcome.error;
  }
  return false;
}
