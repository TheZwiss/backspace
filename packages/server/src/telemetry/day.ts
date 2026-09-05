const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}
