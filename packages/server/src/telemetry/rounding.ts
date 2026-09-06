/**
 * Two significant digits, floored at zero, integers only. Values below 100
 * are already two digits and stay exact; 12345 becomes 12000. The receiver
 * applies the same rule on arrival (scripts/telemetry-receiver/src/validate.ts).
 */
export function roundTwoSignificant(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.floor(n);
  if (whole < 100) return whole;
  const magnitude = 10 ** (Math.floor(Math.log10(whole)) - 1);
  return Math.round(whole / magnitude) * magnitude;
}
