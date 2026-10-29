import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const DISMISSED_KEY = 'backspace_netease_smtc_hint_dismissed';
const SHOWN_KEY = 'backspace_netease_smtc_hint_shown';

function safelyRead(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safelyWrite(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // The hint remains dismissible for this mount when storage is unavailable.
  }
}

/**
 * One-time Windows setup guidance when NetEase is running with a track title
 * but has not published an SMTC session. Persistence is split deliberately:
 * permanent opt-out lives in localStorage, while plain dismissal is remembered
 * only for this app run.
 */
export function MediaSetupHint() {
  const { t } = useTranslation('desktop');
  const [visible, setVisible] = useState(false);
  const [dontRemind, setDontRemind] = useState(false);

  useEffect(() => {
    const bridge = window.backspace;
    if (!bridge?.getMediaSetupHint) return;
    if (safelyRead(localStorage, DISMISSED_KEY) === '1') return;
    if (safelyRead(sessionStorage, SHOWN_KEY) === '1') return;

    let active = true;
    const show = (hint: string | null) => {
      if (!active || hint !== 'netease-smtc') return;
      if (safelyRead(sessionStorage, SHOWN_KEY) === '1') return;
      safelyWrite(sessionStorage, SHOWN_KEY, '1');
      setVisible(true);
    };
    const unsubscribe = bridge.onMediaSetupHint?.(show);
    bridge.getMediaSetupHint().then(show).catch((error) => {
      console.warn('[MediaSetupHint] Could not read setup hint:', error);
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    if (dontRemind) safelyWrite(localStorage, DISMISSED_KEY, '1');
    setVisible(false);
  };

  return (
    <div className="fixed top-4 right-4 z-[300] w-[380px] max-w-[calc(calc(100*var(--app-vw))-2rem)] animate-slide-up">
      <div className="glass-bubble rounded-2xl p-4">
        <div className="flex items-start gap-3">
          <div className="shrink-0 mt-0.5 w-8 h-8 rounded-full flex items-center justify-center bg-accent-sky/15 text-accent-sky" aria-hidden="true">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3h3m10 1a3 3 0 1 1-3-3h3" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-txt-primary">
              {t('mediaSetup.neteaseSmtc.title')}
            </p>
            <p className="text-xs text-txt-secondary mt-1 leading-relaxed">
              {t('mediaSetup.neteaseSmtc.body')}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="shrink-0 -mt-1 -mr-1 p-1.5 rounded-lg text-txt-tertiary hover:text-txt-secondary hover:bg-white/[0.06] transition-colors"
            aria-label={t('mediaSetup.neteaseSmtc.dismiss')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-3 mt-3.5 pl-11">
          <button
            type="button"
            onClick={dismiss}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-primary hover:bg-accent-primary/80 text-white transition-colors"
          >
            {t('mediaSetup.neteaseSmtc.gotIt')}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-txt-tertiary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontRemind}
              onChange={(event) => setDontRemind(event.target.checked)}
              className="accent-[var(--accent-primary)]"
            />
            {t('mediaSetup.neteaseSmtc.dontRemind')}
          </label>
        </div>
      </div>
    </div>
  );
}
