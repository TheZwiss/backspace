import React from 'react';
import { Toggle } from '../ui/Toggle';
import { LOCK_ICON } from '../ui/LockNote';

interface PrivacySettingProps {
  label: string;
  description: string;
  /** Shown under the row while the entity is private. */
  note: string;
  /** Derived from the entity's overrides (`isHiddenFromEveryone`). */
  isPrivate: boolean;
  /** The overrides are still loading, or a switch is being saved. */
  busy: boolean;
  onToggle: () => void;
}

/**
 * The Private switch of channel and category settings. Privacy is @everyone's
 * View Channels deny; the switch shows what the loaded overrides say and
 * flips that one bit (`useEntityOverrides().setBits`).
 */
export function PrivacySetting({ label, description, note, isPrivate, busy, onToggle }: PrivacySettingProps) {
  return (
    <>
      <div className="pt-2 border-t border-border-soft">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-txt-primary">{label}</div>
            <div className="text-xs text-txt-tertiary mt-0.5">{description}</div>
          </div>
          <div className={`flex-shrink-0 ml-4 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
            <Toggle enabled={isPrivate} onChange={onToggle} />
          </div>
        </div>
      </div>

      {isPrivate && (
        <div className="flex items-start gap-2 p-2 bg-surface-input/50 rounded text-xs text-txt-tertiary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="flex-shrink-0 mt-0.5 text-txt-secondary">
            <path d={LOCK_ICON} />
          </svg>
          <span>{note}</span>
        </div>
      )}
    </>
  );
}
