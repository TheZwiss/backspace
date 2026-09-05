const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * True only for a real UTC calendar day. The regex alone is not enough:
 * Date.parse rolls an impossible day such as 2026-02-30 forward instead of
 * failing, so the value has to survive a round trip through the Date unchanged.
 */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}
