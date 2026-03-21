import React, { useState } from 'react';
import { TriStateToggle, type TriState } from './TriStateToggle';
import { PermissionBits } from '../../utils/permissions';

export interface PermissionDef {
  key: keyof typeof PermissionBits;
  label: string;
  bit: bigint;
}

export function OverrideEntry({
  label,
  color,
  permDefs,
  allow,
  deny,
  onChange,
  onRemove,
  isEveryone,
}: {
  label: string;
  color?: string;
  permDefs: PermissionDef[];
  allow: bigint;
  deny: bigint;
  onChange: (allow: bigint, deny: bigint) => void;
  onRemove?: () => void;
  isEveryone?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const getState = (bit: bigint): TriState => {
    if ((allow & bit) !== 0n) return 'allow';
    if ((deny & bit) !== 0n) return 'deny';
    return 'neutral';
  };

  const setState = (bit: bigint, state: TriState) => {
    let newAllow = allow & ~bit;
    let newDeny = deny & ~bit;
    if (state === 'allow') newAllow |= bit;
    if (state === 'deny') newDeny |= bit;
    onChange(newAllow, newDeny);
  };

  // Compact summary of non-neutral permissions
  const summary = permDefs.filter(p => getState(p.bit) !== 'neutral');

  return (
    <div className="rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-interactive-hover transition-colors"
      >
        <span
          className="w-3 h-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: color || '#b9bbbe' }}
        />
        <span className="text-sm font-medium text-txt-primary flex-1 text-left truncate">{label}</span>
        {!expanded && summary.length > 0 && (
          <span className="text-[11px] text-txt-tertiary flex-shrink-0">
            {summary.length} override{summary.length !== 1 ? 's' : ''}
          </span>
        )}
        {onRemove && !isEveryone && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="p-0.5 text-txt-muted hover:text-accent-rose transition-colors"
            title="Remove override"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
          className={`text-txt-muted transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5 border-t border-white/[0.04] pt-2">
          {permDefs.map((perm) => (
            <div key={perm.key} className="flex items-center justify-between">
              <span className="text-[13px] text-txt-secondary">{perm.label}</span>
              <TriStateToggle
                value={getState(perm.bit)}
                onChange={(v) => setState(perm.bit, v)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
