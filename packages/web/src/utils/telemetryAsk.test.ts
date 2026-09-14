import { describe, it, expect } from 'vitest';
import type { TelemetryStatus } from '@backspace/shared';
import { shouldShowAsk, recordDismissal, clearDismissal, ASK_SNOOZE_MS, ASK_STORAGE_KEY } from './telemetryAsk';

function memory(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}
const unanswered: TelemetryStatus = { enabled: null, id: null, lastDay: null, lastError: null, askDue: true };
const declinedEarlier: TelemetryStatus = { ...unanswered, enabled: false, askDue: true };
const declinedHere: TelemetryStatus = { ...unanswered, enabled: false, askDue: false };
const accepted: TelemetryStatus = { ...unanswered, enabled: true, askDue: false };
const T0 = Date.UTC(2026, 8, 6);

describe('shouldShowAsk', () => {
  it('shows only to admins, and only while the instance says the ask is due', () => {
    expect(shouldShowAsk(unanswered, true, memory(), T0)).toBe(true);
    expect(shouldShowAsk(unanswered, false, memory(), T0)).toBe(false);
    expect(shouldShowAsk(declinedEarlier, true, memory(), T0)).toBe(true);
    expect(shouldShowAsk(declinedHere, true, memory(), T0)).toBe(false);
    expect(shouldShowAsk(accepted, true, memory(), T0)).toBe(false);
    expect(shouldShowAsk(null, true, memory(), T0)).toBe(false);
  });

  it('snoozes seven days after a dismissal, every time, without ever giving up', () => {
    const s = memory();
    recordDismissal(s, T0);
    expect(shouldShowAsk(unanswered, true, s, T0 + ASK_SNOOZE_MS - 1)).toBe(false);
    expect(shouldShowAsk(unanswered, true, s, T0 + ASK_SNOOZE_MS)).toBe(true);
    for (let i = 1; i <= 20; i += 1) {
      recordDismissal(s, T0 + i * ASK_SNOOZE_MS);
      expect(shouldShowAsk(unanswered, true, s, T0 + i * ASK_SNOOZE_MS + 1)).toBe(false);
      expect(shouldShowAsk(unanswered, true, s, T0 + (i + 1) * ASK_SNOOZE_MS)).toBe(true);
    }
  });

  it('treats a corrupt record as no record', () => {
    const s = memory();
    s.setItem(ASK_STORAGE_KEY, '{nope');
    expect(shouldShowAsk(unanswered, true, s, T0)).toBe(true);
  });

  it('honours the snooze of a record written before the dismissal count was dropped', () => {
    const s = memory();
    s.setItem(ASK_STORAGE_KEY, JSON.stringify({ dismissals: 2, snoozedUntil: T0 + ASK_SNOOZE_MS }));
    expect(shouldShowAsk(unanswered, true, s, T0)).toBe(false);
    expect(shouldShowAsk(unanswered, true, s, T0 + ASK_SNOOZE_MS)).toBe(true);
  });
});

describe('clearDismissal', () => {
  it('forgets the snooze so the next due ask is not held back by an old "later"', () => {
    const s = memory();
    recordDismissal(s, T0);
    clearDismissal(s);
    expect(s.data.has(ASK_STORAGE_KEY)).toBe(false);
    expect(shouldShowAsk(declinedEarlier, true, s, T0 + 1)).toBe(true);
  });

  it('survives a storage that throws', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(() => clearDismissal(throwing)).not.toThrow();
  });
});
