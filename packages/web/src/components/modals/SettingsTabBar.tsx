import { useSettingsSectionsContext } from './SettingsSectionsContext';

/**
 * Reusable tab bar for settings panels in tab mode.
 * Reads sections and activeSection from SettingsSectionsContext.
 * Drop this into any panel that uses useSettingsSections with onNavigate.
 */
export function SettingsTabBar() {
  const ctx = useSettingsSectionsContext();
  if (!ctx || ctx.sections.length === 0) return null;

  return (
    <div className="flex gap-4 border-b border-white/[0.06] -mt-2 mb-4">
      {ctx.sections.map((s) => (
        <button
          key={s.id}
          onClick={() => ctx.scrollToSection(s.id)}
          className={`pb-2.5 text-sm transition-colors relative ${
            ctx.activeSection === s.id
              ? 'text-txt-primary font-medium'
              : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
        >
          {s.label}
          {ctx.activeSection === s.id && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-primary rounded-full" />
          )}
        </button>
      ))}
    </div>
  );
}
