import { useRef, useCallback, useLayoutEffect } from 'react';
import { useSettingsSectionsContext, type SettingsSection } from '../components/modals/SettingsSectionsContext';

export function useSettingsSections(sections: SettingsSection[]) {
  const ctx = useSettingsSectionsContext();
  // Store ctx setters in refs to avoid depending on the ctx object in effects.
  // The ctx object reference changes when any context value changes, which would
  // cause infinite loops if used as an effect dependency (effect sets state →
  // provider re-renders → new ctx object → effect re-runs).
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

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

  // scrollToSection implementation
  const scrollToSection = useCallback((id: string) => {
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

  // Register scrollToSection into context
  useLayoutEffect(() => {
    ctxRef.current?.setScrollToSection(scrollToSection);
  }, [scrollToSection]);

  // Set up IntersectionObserver
  useLayoutEffect(() => {
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

    // Observe all registered section elements
    sectionElementsRef.current.forEach((el) => {
      observerRef.current?.observe(el);
    });

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [sections, scrollContainerRef]);

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
    scrollToSection,
  };
}
