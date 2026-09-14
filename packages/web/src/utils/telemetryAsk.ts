import type { TelemetryStatus } from '@backspace/shared';

export const ASK_STORAGE_KEY = 'backspace-telemetry-ask';
export const ASK_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
interface AskRecord { snoozedUntil: number }

/**
 * Reads the snooze. Records written before 2026-09-15 also carried a
 * `dismissals` count, back when the second "later" ended the ask for good in
 * that browser; the count is ignored and the snooze in such a record is
 * honoured, so nobody's browser is reset by the change.
 */
function read(storage: Store): AskRecord {
  try {
    const raw = storage.getItem(ASK_STORAGE_KEY);
    if (raw === null) return { snoozedUntil: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as AskRecord).snoozedUntil === 'number') {
      return { snoozedUntil: (parsed as AskRecord).snoozedUntil };
    }
  } catch { /* storage unavailable or corrupt: behave as never dismissed */ }
  return { snoozedUntil: 0 };
}

/**
 * The ask is shown to admins of the home instance while the instance says it
 * is due (`askDue`: never answered, or declined on an earlier minor release),
 * subject to a per-browser snooze: a dismissal hides it for seven days, and
 * then it returns, as many times as it takes. Answers are stored server-side
 * and settle the ask for every admin; dismissals are local and never leave
 * the browser.
 */
export function shouldShowAsk(status: TelemetryStatus | null, isAdmin: boolean, storage: Store, now: number): boolean {
  if (!isAdmin || status === null || !status.askDue) return false;
  return now >= read(storage).snoozedUntil;
}

/**
 * Records a closing without an answer: the ask stays away for seven days in
 * this browser.
 */
export function recordDismissal(storage: Store, now: number): void {
  const next: AskRecord = { snoozedUntil: now + ASK_SNOOZE_MS };
  try { storage.setItem(ASK_STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode: the ask returns next session, which is acceptable */ }
}

/**
 * Forgets the snooze. Called once an answer is stored: a "later" clicked
 * before a no must not hold back the re-ask that a later release brings, and
 * a snooze that outlives a yes is dead weight.
 */
export function clearDismissal(storage: Store): void {
  try { storage.removeItem(ASK_STORAGE_KEY); } catch { /* nothing to forget, or nowhere to forget it from */ }
}
