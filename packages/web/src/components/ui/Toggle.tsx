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
      className={`group relative inline-flex h-6 w-11 items-center justify-center flex-shrink-0 ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <span aria-hidden="true" className={`relative block h-6 w-11 rounded-full transition-colors duration-200 ${enabled ? 'bg-accent-primary' : 'bg-interactive-muted'}`}>
        {/* The thumb springs across, and stretches toward its travel while
            pressed, so the switch answers the press before the click lands. */}
        <span className={`absolute top-1 left-0 h-4 w-4 rounded-full bg-white shadow-sm transition-[transform,width] duration-200 [transition-timing-function:var(--motion-spring)] group-active:w-5 ${enabled ? 'translate-x-6 group-active:translate-x-5' : 'translate-x-1'}`} />
      </span>
    </button>
  );
}
