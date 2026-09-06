import { describe, it, expect } from 'vitest';
import { shouldShowAsk, askIsOver, recordDismissal, ASK_MAX_DISMISSALS, ASK_SNOOZE_MS, ASK_STORAGE_KEY } from './telemetryAsk';

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
  it('snoozes seven days after a dismissal and stops once they are spent', () => {
    const s = memory();
    recordDismissal(s, T0);
    expect(shouldShowAsk(unanswered, true, s, T0 + ASK_SNOOZE_MS - 1)).toBe(false);
    expect(shouldShowAsk(unanswered, true, s, T0 + ASK_SNOOZE_MS)).toBe(true);
    // Spend the dismissals that remain, so the count here cannot drift from the constant.
    for (let i = 1; i < ASK_MAX_DISMISSALS; i += 1) recordDismissal(s, T0 + i * ASK_SNOOZE_MS);
    expect(shouldShowAsk(unanswered, true, s, T0 + 10 * ASK_SNOOZE_MS)).toBe(false);
  });
  it('treats a corrupt record as no record', () => {
    const s = memory();
    s.setItem(ASK_STORAGE_KEY, '{nope');
    expect(shouldShowAsk(unanswered, true, s, T0)).toBe(true);
  });
});

describe('askIsOver', () => {
  it('reports the ask as over once the dismissals are spent', () => {
    const storage = memory();
    for (let i = 0; i < ASK_MAX_DISMISSALS; i += 1) recordDismissal(storage, 0);

    expect(askIsOver(storage)).toBe(true);
  });

  it('reports the ask as not over before then, and on a storage that throws', () => {
    const storage = memory();
    expect(askIsOver(storage)).toBe(false);
    recordDismissal(storage, 0);
    expect(askIsOver(storage)).toBe(false);

    // A browser that refuses storage must not be treated as one that already
    // answered: the ask is the point of the feature, and losing it silently is
    // worse than showing it once more.
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(askIsOver(throwing)).toBe(false);
  });
});
