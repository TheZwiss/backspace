import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

export interface SettingsSection {
  id: string;
  label: string;
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

  return (
    <SettingsSectionsContext.Provider
      value={{
        sections,
        activeSection,
        scrollToSection,
        scrollContainerRef,
        setSections,
        setActiveSection,
        setScrollToSection: setScrollToSectionStable,
      }}
    >
      {children}
    </SettingsSectionsContext.Provider>
  );
}

export function useSettingsSectionsContext() {
  return useContext(SettingsSectionsContext);
}
