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
 * returned function is called. That function withdraws the request if it is
 * still queued, releases the lock if it is held, and resolves once the lock
 * is gone. Returns null when the Web Locks API is unavailable.
 */
export function holdVoiceSessionLock(): (() => Promise<void>) | null {
  const locks = lockManager();
  if (!locks) return null;
  const controller = new AbortController();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const gone = locks
    .request(VOICE_SESSION_LOCK, { mode: 'shared', signal: controller.signal }, () => held)
    .then(() => undefined, () => undefined);
  return () => {
    controller.abort();
    release();
    return gone;
  };
}

/**
 * Runs `task` while holding the exclusive voice-session lock, which is only
 * granted when no tab holds the shared lock. Resolves true once the task has
 * run, false if `signal` aborted first.
 *
 * Lock requests are granted in order, so a tab that starts a session while
 * this request is queued has its shared request queued behind it and does not
 * hold the lock yet. The task therefore also yields to any shared request
 * still pending when the exclusive lock is granted, and queues again behind it.
 *
 * `after` is awaited before the lock is requested. The caller passes the
 * release of its own shared lock there, so a tab never queues behind itself.
 */
export async function runWhenNoVoiceSession(
  task: () => Promise<void>,
  signal: AbortSignal,
  after?: Promise<void>,
): Promise<boolean> {
  if (after) await after;
  if (signal.aborted) return false;

  const locks = lockManager();
  if (!locks) {
    await task();
    return true;
  }

  while (!signal.aborted) {
    let outcome: 'ran' | 'yielded' | 'aborted';
    try {
      outcome = await locks.request(
        VOICE_SESSION_LOCK,
        { mode: 'exclusive', signal },
        async (): Promise<'ran' | 'yielded' | 'aborted'> => {
          const { pending = [] } = await locks.query();
          if (signal.aborted) return 'aborted';
          if (pending.some((request) => request.name === VOICE_SESSION_LOCK && request.mode === 'shared')) {
            return 'yielded';
          }
          await task();
          return 'ran';
        },
      );
    } catch (error) {
      if (isAbortError(error)) return false;
      throw error;
    }
    if (outcome === 'ran') return true;
    if (outcome === 'aborted') return false;
  }
  return false;
}
