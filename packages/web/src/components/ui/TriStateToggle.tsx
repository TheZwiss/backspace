import React from 'react';

export type TriState = 'allow' | 'neutral' | 'deny';

export function TriStateToggle({
  value,
  onChange,
  disabled,
}: {
  value: TriState;
  onChange: (v: TriState) => void;
  disabled?: boolean;
}) {
  const btnClass = (v: TriState, active: boolean) => {
    const base = 'w-6 h-6 flex items-center justify-center rounded-full transition-colors text-xs font-bold';
    if (disabled) return `${base} cursor-not-allowed opacity-40`;
    if (!active) return `${base} cursor-pointer text-txt-muted hover:text-txt-tertiary`;
    switch (v) {
      case 'deny': return `${base} cursor-pointer bg-accent-rose/15 text-accent-rose`;
      case 'neutral': return `${base} cursor-pointer bg-white/[0.06] text-txt-tertiary`;
      case 'allow': return `${base} cursor-pointer bg-accent-primary/15 text-accent-primary`;
    }
  };

  return (
    <div className="flex items-center gap-0.5 bg-surface-input rounded-full p-0.5">
      <button
        className={btnClass('deny', value === 'deny')}
        onClick={() => !disabled && onChange(value === 'deny' ? 'neutral' : 'deny')}
        title="Deny"
      >
        ✕
      </button>
      <button
        className={btnClass('neutral', value === 'neutral')}
        onClick={() => !disabled && onChange('neutral')}
        title="Neutral (inherit)"
      >
        /
      </button>
      <button
        className={btnClass('allow', value === 'allow')}
        onClick={() => !disabled && onChange(value === 'allow' ? 'neutral' : 'allow')}
        title="Allow"
      >
        ✓
      </button>
    </div>
  );
}
