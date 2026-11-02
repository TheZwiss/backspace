import type { NudgeMode } from '../stores/nudgePreferences';

export interface NudgeContext {
  focused: boolean;
  minimized: boolean;
  displays: { id: number; label: string; primary: boolean; app: boolean }[];
  gameRunning: boolean;
  foregroundGame: boolean;
  gameDisplayIds: number[];
  gameDetectionUncertain: boolean;
}
export interface NudgeRules {
  mode: NudgeMode;
  scope: 'app' | 'desktop' | 'both' | 'off';
  sound: boolean;
  volume: number;
  monitor: 'all' | 'primary' | 'app' | 'secondary';
  gameDetection: 'auto' | 'on' | 'off';
  gameTrigger: 'foreground' | 'running';
  gameMonitor: 'auto' | 'primary' | 'app' | 'secondary';
  gameAction: 'normal' | 'notification' | 'other-displays' | 'off';
  gameFallback: 'notification' | 'app' | 'off';
}
export interface NudgePlan { destination: 'app' | 'desktop' | 'off'; mode: NudgeMode; sound: boolean; volume: number; displayIds: number[] }

export function resolveNudgePlan(rules: NudgeRules, context: NudgeContext): NudgePlan {
  const appDestination = rules.scope === 'app' || (rules.scope === 'both' && context.focused && !context.minimized);
  const selected = context.displays.filter(d => appDestination ? d.app : rules.monitor === 'all' || (rules.monitor === 'primary' && d.primary)
    || (rules.monitor === 'app' && d.app) || (rules.monitor === 'secondary' && !d.primary));
  const volume = Math.max(0, Math.min(100, rules.volume)) / 100;
  const plan: NudgePlan = { destination: 'off', mode: rules.mode, sound: rules.sound && volume > 0, volume, displayIds: selected.map(d => d.id) };
  if (rules.scope === 'off') return plan;
  if (rules.scope === 'desktop' && context.focused && !context.minimized) return plan;
  plan.destination = rules.scope === 'app' || (rules.scope === 'both' && context.focused && !context.minimized) ? 'app' : 'desktop';
  if (plan.destination === 'app' && context.minimized) return { ...plan, destination: 'off' };
  const gaming = rules.gameDetection === 'on' || (rules.gameDetection === 'auto' && (
    (rules.gameTrigger === 'running' ? context.gameRunning : context.foregroundGame)
    || (context.gameDetectionUncertain && context.gameRunning)));
  if (!gaming || rules.gameAction === 'normal') return plan.destination === 'desktop' && !selected.length ? { ...plan, destination: 'off' } : plan;
  if (rules.gameAction === 'off') return { ...plan, destination: 'off' };
  if (rules.gameAction === 'notification') return { ...plan, mode: 'notification', displayIds: selected.length ? plan.displayIds : context.displays.filter(d => d.primary).map(d => d.id) };
  // An unknown game monitor is never treated as a free monitor.
  const gameIds = rules.gameMonitor === 'auto' ? context.gameDisplayIds : context.displays.filter(d =>
    (rules.gameMonitor === 'primary' && d.primary) || (rules.gameMonitor === 'app' && d.app)
    || (rules.gameMonitor === 'secondary' && !d.primary)).map(d => d.id);
  const uncertain = rules.gameMonitor === 'auto' && context.gameDetectionUncertain;
  const free = uncertain || !gameIds.length ? [] : selected.filter(d => !gameIds.includes(d.id));
  if (free.length && plan.destination === 'desktop') return { ...plan, displayIds: free.map(d => d.id) };
  const appDisplays = context.displays.filter(d => d.app);
  if (free.length && plan.destination === 'app' && appDisplays.length && appDisplays.every(d => free.some(f => f.id === d.id))) return plan;
  if (rules.gameFallback === 'off') return { ...plan, destination: 'off' };
  if (rules.gameFallback === 'app') return { ...plan, destination: context.minimized ? 'off' : 'app', mode: 'notification' };
  return { ...plan, mode: 'notification', displayIds: selected.length ? plan.displayIds : context.displays.filter(d => d.primary).map(d => d.id) };
}
