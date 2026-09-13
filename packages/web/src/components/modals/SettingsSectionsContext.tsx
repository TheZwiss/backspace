import React, { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';

export interface SettingsSection {
  id: string;
  label: string;
  /** A count worth showing, e.g. pending federation approvals. */
  badgeCount?: number;
  /** A boolean "something is waiting here", e.g. an available instance update. */
  badgeDot?: boolean;
  /**
   * Render this section's entry as the hello button rather than as a text
   * link. Set while the instance is not sending the daily hello, and cleared
   * the moment it is, so the invitation is only ever offering something that
   * is not already happening. The entry still navigates — it does not answer
   * anything on the way.
   */
  invite?: boolean;
}

interface SettingsSectionsContextValue {
  sections: SettingsSection[];
  activeSection: string;
  scrollToSection: (id: string) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  setSections: (sections: SettingsSection[]) => void;
  setActiveSection: (id: string) => void;
  setScrollToSection: (fn: (id: string) => void) => void;
}

const SettingsSectionsContext = createContext<SettingsSectionsContextValue | null>(null);

export function SettingsSectionsProvider({ children }: { children: React.ReactNode }) {
  const [sections, setSections] = useState<SettingsSection[]>([]);
  const [activeSection, setActiveSection] = useState('');
  const [scrollFn, setScrollFn] = useState<((id: string) => void) | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const scrollToSection = useCallback((id: string) => {
    scrollFn?.(id);
  }, [scrollFn]);

  // setScrollToSection receives a function, so wrap in updater to avoid
  // React interpreting it as a state updater function
  const setScrollToSectionStable = useCallback((fn: (id: string) => void) => {
    setScrollFn(() => fn);
  }, []);

  const value = useMemo(() => ({
    sections,
    activeSection,
    scrollToSection,
    scrollContainerRef,
    setSections,
    setActiveSection,
    setScrollToSection: setScrollToSectionStable,
  }), [sections, activeSection, scrollToSection, scrollContainerRef, setScrollToSectionStable]);

  return (
    <SettingsSectionsContext.Provider value={value}>
      {children}
    </SettingsSectionsContext.Provider>
  );
}

export function useSettingsSectionsContext() {
  return useContext(SettingsSectionsContext);
}
