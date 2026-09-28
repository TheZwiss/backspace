import React from 'react';
import { useTranslation } from 'react-i18next';

export type TriState = 'allow' | 'neutral' | 'deny';

export function TriStateToggle({
  value,
  onChange,
  disabled,
  label,
}: {
  value: TriState;
  onChange: (v: TriState) => void;
  /** Locked: the current state stays visible, but no button changes it. */
  disabled?: boolean;
  /** Names the group of three buttons, e.g. the permission it sets. */
  label?: string;
}) {
  const { t } = useTranslation(['spaces']);
  const btnClass = (v: TriState, active: boolean) => {
    const base = 'w-6 h-6 flex items-center justify-center rounded-full transition-colors text-xs font-bold';
    const interaction = disabled ? 'cursor-not-allowed' : 'cursor-pointer';
    if (!active) return `${base} ${interaction} text-txt-tertiary${disabled ? '' : ' hover:text-txt-secondary'}`;
    switch (v) {
      case 'deny': return `${base} ${interaction} bg-accent-rose/15 text-accent-rose`;
      case 'neutral': return `${base} ${interaction} bg-white/[0.06] text-txt-tertiary`;
      case 'allow': return `${base} ${interaction} bg-accent-primary/15 text-accent-primary`;
    }
  };

  const names: Record<TriState, string> = {
    deny: t('spaces:permissions.tristate.deny'),
    neutral: t('spaces:permissions.tristate.neutral'),
    allow: t('spaces:permissions.tristate.allow'),
  };

  const button = (v: TriState, glyph: string, next: TriState) => (
    <button
      type="button"
      className={btnClass(v, value === v)}
      onClick={() => !disabled && onChange(next)}
      disabled={disabled}
      aria-pressed={value === v}
      aria-label={names[v]}
      title={names[v]}
    >
      {glyph}
    </button>
  );

  return (
    <div
      role="group"
      aria-label={label}
      className={`flex items-center gap-0.5 bg-surface-input rounded-full p-0.5${disabled ? ' opacity-50' : ''}`}
    >
      {button('deny', '✕', value === 'deny' ? 'neutral' : 'deny')}
      {button('neutral', '/', 'neutral')}
      {button('allow', '✓', value === 'allow' ? 'neutral' : 'allow')}
    </div>
  );
}
