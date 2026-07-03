import { useRef, useCallback, useLayoutEffect } from 'react';
import { useSettingsSectionsContext, type SettingsSection } from '../components/modals/SettingsSectionsContext';

interface UseSettingsSectionsOptions {
  /**
   * Tab mode: sidebar sub-links switch tabs instead of scrolling.
   * When provided, clicking a sub-link calls onNavigate(id) instead of scrollIntoView.
   * No IntersectionObserver is set up — the caller manages activeSection.
   */
  onNavigate?: (id: string) => void;
  /** In tab mode, the currently active tab id (drives sidebar highlight) */
  activeTab?: string;
}

export function useSettingsSections(sections: SettingsSection[], options?: UseSettingsSectionsOptions) {
  const ctx = useSettingsSectionsContext();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const onNavigateRef = useRef(options?.onNavigate);
  onNavigateRef.current = options?.onNavigate;

  const isTabMode = !!options?.onNavigate;

  const scrollContainerRef = ctx?.scrollContainerRef ?? null;
  const sectionElementsRef = useRef(new Map<string, HTMLElement>());
  const sectionRefCallbacksRef = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const suppressObserverRef = useRef(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Register sections into context synchronously (useLayoutEffect prevents flicker)
  useLayoutEffect(() => {
    ctxRef.current?.setSections(sections);
    return () => {
      ctxRef.current?.setSections([]);
      ctxRef.current?.setActiveSection('');
    };
  }, [sections]);

  // In tab mode, sync activeTab to context
  useLayoutEffect(() => {
    if (isTabMode && options?.activeTab) {
      ctxRef.current?.setActiveSection(options.activeTab);
    }
  }, [isTabMode, options?.activeTab]);

  // navigateToSection: either calls onNavigate callback (tab mode) or scrollIntoView (scroll mode)
  const navigateToSection = useCallback((id: string) => {
    if (onNavigateRef.current) {
      // Tab mode: delegate to caller
      onNavigateRef.current(id);
      return;
    }

    // Scroll mode: smooth scroll to element
    const el = sectionElementsRef.current.get(id);
    if (!el) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    suppressObserverRef.current = true;
    ctxRef.current?.setActiveSection(id);

    el.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });

    const container = scrollContainerRef?.current;
    if (container && 'onscrollend' in container) {
      container.addEventListener('scrollend', () => {
        suppressObserverRef.current = false;
      }, { once: true });
    } else {
      setTimeout(() => {
        suppressObserverRef.current = false;
      }, prefersReducedMotion ? 50 : 500);
    }
  }, [scrollContainerRef]);

  // Register navigateToSection into context
  useLayoutEffect(() => {
    ctxRef.current?.setScrollToSection(navigateToSection);
  }, [navigateToSection]);

  // Set up IntersectionObserver (scroll mode only)
  useLayoutEffect(() => {
    if (isTabMode) return; // No scroll-spy in tab mode

    const container = scrollContainerRef?.current;
    if (!container || sections.length === 0) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (suppressObserverRef.current) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('data-section-id');
            if (id) {
              ctxRef.current?.setActiveSection(id);
            }
          }
        }
      },
      {
        root: container,
        rootMargin: '-20% 0px -70% 0px',
      }
    );

    sectionElementsRef.current.forEach((el) => {
      observerRef.current?.observe(el);
    });

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [sections, scrollContainerRef, isTabMode]);

  // Stable callback ref factory (cached per id to avoid re-attach)
  const sectionRef = useCallback((id: string) => {
    let cb = sectionRefCallbacksRef.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) {
          el.setAttribute('data-section-id', id);
          sectionElementsRef.current.set(id, el);
          observerRef.current?.observe(el);
        } else {
          const prev = sectionElementsRef.current.get(id);
          if (prev) observerRef.current?.unobserve(prev);
          sectionElementsRef.current.delete(id);
        }
      };
      sectionRefCallbacksRef.current.set(id, cb);
    }
    return cb;
  }, []);

  return {
    sectionRef,
    scrollToSection: navigateToSection,
  };
}
