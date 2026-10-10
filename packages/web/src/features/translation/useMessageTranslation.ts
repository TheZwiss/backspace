import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import {
  enqueueTranslation,
  loadTranslationSettings,
  resetTranslationScope,
  trackTranslatedMessage,
  useTranslationStore,
} from './translationStore';

export function useTranslationSettings() {
  const accountId = useAuthStore((s) => s.user?.id ?? '');
  const origin = window.location.origin;
  const scope = accountId ? `${origin}\n${accountId}` : '';
  const storedScope = useTranslationStore((s) => s.scope);
  const storedSettings = useTranslationStore((s) => s.settings);
  useEffect(() => {
    if (!accountId) {
      resetTranslationScope('');
      return;
    }
    void loadTranslationSettings({ scope, accountId });
  }, [scope, accountId]);
  return {
    scope,
    accountId,
    settings: storedScope === scope ? storedSettings : null,
  };
}
// Wait for scrolling/edits to settle before submitting a billable background request.
export const TRANSLATION_SETTLE_MS = 400;
function eligibleMessage(input: { text: string; enabled: boolean }): boolean {
  return input.enabled && /\p{L}/u.test(input.text) && input.text.length <= 6000;
}
export function useMessageTranslation(input: { identity: string; text: string; enabled: boolean }) {
  const { scope, accountId, settings } = useTranslationSettings();
  const generation = useTranslationStore((s) => s.generation);
  const automaticError = useTranslationStore((s) => s.automaticError);
  const tracked = useTranslationStore((s) => !!s.trackedMessages[input.identity]);
  const key = JSON.stringify([scope, generation, input.identity, input.text]);
  const entry = useTranslationStore((s) => s.entries[key]);
  const anchorRef = useRef<HTMLDivElement>(null);
  const cancelManual = useRef<(() => void) | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const eligible = eligibleMessage(input);
  const automatic = !!settings?.preferences.automatic;
  const watch = !!settings?.preferences.consent && (automatic || tracked);
  useEffect(() => {
    if (entry?.state === 'done' && entry.result.kind === 'translated') trackTranslatedMessage(input.identity);
  }, [entry, input.identity]);
  useEffect(() => () => cancelManual.current?.(), [key, eligible]);
  useEffect(() => {
    const node = anchorRef.current;
    if (!node || !eligible || !watch || typeof IntersectionObserver === 'undefined') return;
    let intersecting = false;
    const update = () => setVisible(intersecting && document.visibilityState === 'visible');
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = !!entry?.isIntersecting;
      update();
    });
    observer.observe(node);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      setVisible(false);
    };
  }, [eligible, watch]);
  useEffect(() => {
    if (!visible || !eligible || !watch || !settings || automaticError || entry) return;
    let cancel: (() => void) | undefined;
    const timer = setTimeout(() => {
      cancel = enqueueTranslation({
        key,
        scope,
        accountId,
        text: input.text,
        revision: settings.revision,
        automatic,
        background: true,
      });
    }, TRANSLATION_SETTLE_MS);
    return () => {
      clearTimeout(timer);
      cancel?.();
    };
  }, [
    key,
    visible,
    eligible,
    watch,
    settings,
    automatic,
    automaticError,
    entry,
    scope,
    accountId,
    input.text,
  ]);
  const translate = () => {
    if (
      !settings?.preferences.consent ||
      !(settings.preferences.engine ?? settings.preferences.defaultConnection)
    ) {
      useUIStore.getState().openModal('userSettings', { tab: 'translation' });
      return;
    }
    trackTranslatedMessage(input.identity);
    cancelManual.current?.();
    cancelManual.current = enqueueTranslation({
      key,
      scope,
      accountId,
      text: input.text,
      revision: settings.revision,
      automatic: false,
    });
  };
  return {
    anchorRef,
    entry: eligible ? entry : undefined,
    translate: eligible ? translate : undefined,
    showOriginal: settings?.preferences.showOriginal ?? true,
    cacheKey: key,
  };
}
