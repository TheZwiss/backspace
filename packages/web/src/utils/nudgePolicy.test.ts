import { describe, expect, it } from 'vitest';
import { resolveNudgePlan, type NudgeContext, type NudgeRules } from './nudgePolicy';

const rules: NudgeRules = { mode: 'full', scope: 'both', sound: true, volume: 60, monitor: 'all', gameDetection: 'auto', gameTrigger: 'foreground', gameMonitor: 'auto', gameAction: 'notification', gameFallback: 'notification' };
const context: NudgeContext = { focused: false, minimized: false, displays: [
  { id: 1, label: 'Primary', primary: true, app: false }, { id: 2, label: 'Left', primary: false, app: true }, { id: 3, label: 'Right', primary: false, app: false },
], gameRunning: false, foregroundGame: false, gameDisplayIds: [], gameDetectionUncertain: false };
const plan = (preferences: Partial<NudgeRules> = {}, state: Partial<NudgeContext> = {}) => resolveNudgePlan({ ...rules, ...preferences }, { ...context, ...state });

describe('recipient nudge rules', () => {
  it('disables all destinations', () => expect(plan({ scope: 'off' }).destination).toBe('off'));
  it('keeps app-only effects inside even in the background', () => expect(plan({ scope: 'app' }).destination).toBe('app'));
  it('does not surface app-only effects while minimized', () => expect(plan({ scope: 'app' }, { minimized: true }).destination).toBe('off'));
  it('suppresses desktop-only effects when focused', () => expect(plan({ scope: 'desktop' }, { focused: true }).destination).toBe('off'));
  it('routes automatic scope into the focused app', () => expect(plan({}, { focused: true }).destination).toBe('app'));
  it('routes automatic scope to desktop when minimized', () => expect(plan({}, { minimized: true }).destination).toBe('desktop'));
  it.each<[NudgeRules['monitor'], number[]]>([['all', [1, 2, 3]], ['primary', [1]], ['app', [2]], ['secondary', [2, 3]]])('selects %s monitors', (monitor, ids) => expect(plan({ monitor }).displayIds).toEqual(ids));
  it('retains the sound preference', () => expect(plan({ sound: false }).sound).toBe(false));
  it('uses the attention volume independently of general SFX volume', () => expect(plan({ volume: 30 }).volume).toBe(.3));
  it('mutes calls when their volume is zero', () => expect(plan({ volume: 0 }).sound).toBe(false));
  it('reduces foreground game effects to notices', () => expect(plan({}, { gameRunning: true, foregroundGame: true }).mode).toBe('notification'));
  it('does not assume a background game is focused', () => expect(plan({}, { gameRunning: true }).mode).toBe('full'));
  it('does not infer gaming merely from an unreadable background window', () => expect(plan({}, { gameDetectionUncertain: true, gameRunning: false, foregroundGame: false }).mode).toBe('full'));
  it('can protect games even in the background', () => expect(plan({ gameTrigger: 'running' }, { gameRunning: true }).mode).toBe('notification'));
  it('supports manual game mode for unknown games', () => expect(plan({ gameDetection: 'on' }).mode).toBe('notification'));
  it('can disable game handling', () => expect(plan({ gameDetection: 'off' }, { foregroundGame: true }).mode).toBe('full'));
  it('can suppress all calls during gaming', () => expect(plan({ gameDetection: 'on', gameAction: 'off' }).destination).toBe('off'));
  it('allows normal behavior during games when selected', () => expect(plan({ gameDetection: 'on', gameAction: 'normal' }).mode).toBe('full'));
  it('excludes every monitor touched by a spanning game', () => expect(plan({ gameDetection: 'on', gameAction: 'other-displays' }, { gameDisplayIds: [1, 2] }).displayIds).toEqual([3]));
  it('does not treat unknown screens as free', () => expect(plan({ gameDetection: 'on', gameAction: 'other-displays' }, { gameDetectionUncertain: true, gameDisplayIds: [1] }).mode).toBe('notification'));
  it('can silence unknown-monitor cases', () => expect(plan({ gameDetection: 'on', gameAction: 'other-displays', gameFallback: 'off' }).destination).toBe('off'));
  it('can use an app notice for unknown-monitor cases', () => expect(plan({ gameDetection: 'on', gameAction: 'other-displays', gameFallback: 'app' })).toMatchObject({ destination: 'app', mode: 'notification' }));
  it('does not restore the app for an app fallback', () => expect(plan({ gameDetection: 'on', gameAction: 'other-displays', gameFallback: 'app' }, { minimized: true }).destination).toBe('off'));
  it('supports a manually specified game monitor', () => expect(plan({ gameDetection: 'on', gameAction: 'other-displays', gameMonitor: 'primary' }, { gameDetectionUncertain: true }).displayIds).toEqual([2, 3]));
  it('respects the chosen destination monitor before excluding games', () => expect(plan({ monitor: 'primary', gameDetection: 'on', gameAction: 'other-displays', gameFallback: 'off' }, { gameDisplayIds: [1] }).destination).toBe('off'));
  it('does not escape an app-only restriction to use another monitor', () => expect(plan({ scope: 'app', gameDetection: 'on', gameAction: 'other-displays' }, { gameDisplayIds: [2] })).toMatchObject({ destination: 'app', mode: 'notification' }));
  it('supports a single-monitor machine without animating the game', () => expect(plan({ gameDetection: 'on', gameAction: 'other-displays' }, { displays: [context.displays[0]!], gameDisplayIds: [1] }).mode).toBe('notification'));
  it('suppresses unavailable secondary monitor targets', () => expect(plan({ monitor: 'secondary' }, { displays: [context.displays[0]!] }).destination).toBe('off'));
  it('does not apply an external monitor filter to app-only rendering', () => expect(plan({ scope: 'app', monitor: 'primary', gameDetection: 'on', gameAction: 'other-displays' }, { gameDisplayIds: [1] })).toMatchObject({ destination: 'app', mode: 'full', displayIds: [2] }));
  it('reduces an app spanning both a free monitor and a game monitor to a notice', () => expect(plan({ scope: 'app', gameDetection: 'on', gameAction: 'other-displays' }, { displays: context.displays.map(d => ({ ...d, app: d.id < 3 })), gameDisplayIds: [1] }).mode).toBe('notification'));
});
