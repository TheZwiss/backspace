interface ToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
  /**
   * Accessible name. A switch carries no text of its own, so where the visible
   * label is not wired to it, pass the same words here.
   */
  ariaLabel?: string;
}

export function Toggle({ enabled, onChange, disabled, ariaLabel }: ToggleProps) {
  return (
    <button data-icon-motion="press"
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel}
      onClick={() => onChange(!enabled)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center justify-center flex-shrink-0 ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <span aria-hidden="true" className={`relative block h-6 w-11 rounded-full transition-colors ${enabled ? 'bg-accent-primary' : 'bg-interactive-muted'}`}>
        <span className={`absolute top-1 left-0 h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
      </span>
    </button>
  );
}
