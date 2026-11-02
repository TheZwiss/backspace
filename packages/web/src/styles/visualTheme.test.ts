// @vitest-environment node
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import theme from '../../../desktop/resources/ui-theme.json';
const css = fs.readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const rgb = (name: string) => {
  const value = css.match(new RegExp(`--${name}:\\s*(\\d+) (\\d+) (\\d+);`));
  if (!value) throw new Error('Missing theme color: ' + name);
  return value.slice(1).map(Number);
};
const luminance = (color: number[]) => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((total, v, i) => total + v * [.2126, .7152, .0722][i]!, 0);
const contrast = (a: number[], b: number[]) => { const values = [luminance(a), luminance(b)].sort((x, y) => x - y); return (values[1]! + .05) / (values[0]! + .05); };
describe('visual theme accessibility contracts', () => {
  it('keeps small primary-button text legible across interaction states', () => {
    for (const color of ['accent-primary', 'accent-primary-hover', 'accent-primary-active']) expect(contrast([255, 255, 255], rgb(color))).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps meaningful tertiary text readable on app surfaces', () => {
    for (const background of ['bg-base', 'bg-channel', 'bg-elevated']) expect(contrast(rgb('text-tertiary'), rgb(background))).toBeGreaterThanOrEqual(4.5);
  });
  it('uses a dark foreground for pastel warning and destructive actions', () => {
    for (const color of ['accent-amber', 'accent-rose']) expect(contrast(rgb('bg-base'), rgb(color))).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps the native notification palette aligned with the app', () => {
    const hex = (color: number[]) => '#' + color.map(v => v.toString(16).padStart(2, '0')).join('');
    expect(theme.accent).toBe(hex(rgb('accent-primary')));
    expect(theme.surface).toBe(hex(rgb('bg-elevated')));
    expect(theme.foreground).toBe(hex(rgb('text-primary')));
  });
  it('does not suppress keyboard focus globally', () => {
    expect(css).not.toMatch(/outline:\s*none\s*!important/);
  });
});
