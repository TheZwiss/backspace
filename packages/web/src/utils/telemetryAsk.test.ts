import { describe, it, expect } from 'vitest';
import { shouldShowAsk, recordDismissal, ASK_SNOOZE_MS, ASK_STORAGE_KEY } from './telemetryAsk';

function memory(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}
const unanswered = { enabled: null, id: null, lastDay: null, lastError: null };
const T0 = Date.UTC(2026, 8, 6);

describe('shouldShowAsk', () => {
  it('shows only to admins while the instance was never asked', () => {
    expect(shouldShowAsk(unanswered, true, memory(), T0)).toBe(true);
    expect(shouldShowAsk(unanswered, false, memory(), T0)).toBe(false);
    expect(shouldShowAsk({ ...unanswered, enabled: false }, true, memory(), T0)).toBe(false);
    expect(shouldShowAsk({ ...unanswered, enabled: true }, true, memory(), T0)).toBe(false);
    expect(shouldShowAsk(null, true, memory(), T0)).toBe(false);
  });
  it('snoozes seven days after a dismissal and stops after the second', () => {
    const s = memory();
    recordDismissal(s, T0);
    expect(shouldShowAsk(unanswered, true, s, T0 + ASK_SNOOZE_MS - 1)).toBe(false);
    expect(shouldShowAsk(unanswered, true, s, T0 + ASK_SNOOZE_MS)).toBe(true);
    recordDismissal(s, T0 + ASK_SNOOZE_MS);
    expect(shouldShowAsk(unanswered, true, s, T0 + 10 * ASK_SNOOZE_MS)).toBe(false);
  });
  it('treats a corrupt record as no record', () => {
    const s = memory();
    s.setItem(ASK_STORAGE_KEY, '{nope');
    expect(shouldShowAsk(unanswered, true, s, T0)).toBe(true);
  });
});
