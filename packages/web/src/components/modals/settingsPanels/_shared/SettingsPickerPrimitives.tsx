import type { ReactNode } from 'react';

/**
 * Section wrapper used by audio/video picker subsections (AudioInputSection,
 * AudioOutputSection, …). Provides the small uppercase title above a soft
 * inset card. Settings-panel-internal — kept under `_shared/` rather than
 * promoted to `ui/` because nothing outside settings panels needs this look.
 */
export function SectionShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{title}</div>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">{children}</div>
    </div>
  );
}

export interface DropdownItemProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

/**
 * Single row of a settings picker dropdown (input device, output device, etc.).
 * Renders a checkmark on the active row and indents inactive labels by the
 * checkmark's width so labels align across rows. Settings-panel-internal.
 */
export function DropdownItem({ label, active, onClick }: DropdownItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full px-3 py-2 text-left text-[13px] hover:bg-interactive-hover transition-colors flex items-center gap-2 ${
        active ? 'text-txt-primary' : 'text-txt-secondary'
      }`}
    >
      {active && (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-accent-primary flex-shrink-0">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      )}
      <span className={`truncate ${active ? '' : 'pl-6'}`}>{label}</span>
    </button>
  );
}
