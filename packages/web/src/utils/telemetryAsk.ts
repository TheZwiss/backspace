import type { TelemetryStatus } from '@backspace/shared';

export const ASK_STORAGE_KEY = 'backspace-telemetry-ask';
export const ASK_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const ASK_MAX_DISMISSALS = 2;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
interface AskRecord { dismissals: number; snoozedUntil: number }

function read(storage: Store): AskRecord {
  try {
    const raw = storage.getItem(ASK_STORAGE_KEY);
    if (raw === null) return { dismissals: 0, snoozedUntil: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null
      && typeof (parsed as AskRecord).dismissals === 'number'
      && typeof (parsed as AskRecord).snoozedUntil === 'number') {
      return parsed as AskRecord;
    }
  } catch { /* storage unavailable or corrupt: behave as never dismissed */ }
  return { dismissals: 0, snoozedUntil: 0 };
}

/**
 * The ask is shown to admins of the home instance while the instance-wide
 * setting is still "never asked", subject to a per-browser snooze: a
 * dismissal hides it for seven days, and the second dismissal hides it for
 * good in that browser. Answers are stored server-side and end the ask for
 * every admin; dismissals are local and never leave the browser.
 */
export function shouldShowAsk(status: TelemetryStatus | null, isAdmin: boolean, storage: Store, now: number): boolean {
  if (!isAdmin || status === null || status.enabled !== null) return false;
  const record = read(storage);
  if (record.dismissals >= ASK_MAX_DISMISSALS) return false;
  return now >= record.snoozedUntil;
}

/**
 * Records a dismissal without an answer: it snoozes the ask for seven days in
 * this browser, and once the count reaches ASK_MAX_DISMISSALS the ask is over
 * for good here.
 */
export function recordDismissal(storage: Store, now: number): void {
  const record = read(storage);
  const next: AskRecord = { dismissals: record.dismissals + 1, snoozedUntil: now + ASK_SNOOZE_MS };
  try { storage.setItem(ASK_STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode: the ask returns next session, which is acceptable */ }
}
