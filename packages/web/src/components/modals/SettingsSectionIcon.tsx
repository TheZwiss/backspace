/** The sub-sections that have an icon in the settings sidebar. */
export type SettingsSectionIconName =
  | 'general' | 'registration' | 'federation' | 'streaming' | 'storage' | 'users' | 'updates' | 'telemetry';

/**
 * The small line icon in front of a settings sub-section link. Same stroke
 * style as the sidebar's tab icons (`SettingsNavIcon`), drawn smaller. It
 * dims until the link is hovered, focused or current, like the tab icons.
 */
export function SettingsSectionIcon({ name }: { name: SettingsSectionIconName }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-[15px] h-[15px] shrink-0 opacity-70 group-hover:opacity-100 group-focus-visible:opacity-100 group-aria-[current=true]:opacity-100 transition-opacity"
    >
      {name === 'general' && <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>}
      {name === 'registration' && <><circle cx="10" cy="8" r="3.25" /><path d="M3.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" /></>}
      {name === 'federation' && <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3Z" /></>}
      {name === 'streaming' && <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="m10 8.5 4 2.5-4 2.5v-5ZM8 20h8" /></>}
      {name === 'storage' && <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>}
      {name === 'users' && <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 5.2a3 3 0 0 1 0 5.6M18 14.2A6 6 0 0 1 21 20" /></>}
      {name === 'updates' && <><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></>}
      {name === 'telemetry' && <><path d="M3 12h4l2.5-6 4 12 2.5-6H21" /></>}
    </svg>
  );
}
