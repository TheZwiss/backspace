import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useUpdateStore,
  shouldPrompt,
  canRestartToInstall,
  statusVersion,
} from '../../stores/updateStore';
import { useUIStore } from '../../stores/uiStore';

/**
 * The persistent update prompt.
 *
 * Renders nothing in a browser, nothing while an update is merely downloading
 * or being checked for, and nothing for a version the user has already
 * dismissed. When it does render, every button it offers actually does
 * something: a Restart button appears only on a build that can install in
 * place, and a build that cannot says so in plain words instead of presenting a
 * control that silently fails.
 *
 * Surface tier is `.glass-bubble`: this is a persistent floating control, which
 * is that tier's definition in docs/systems/design-system.md. It was previously
 * `.glass-pill`, which the spec reserves for inline decorations.
 */
export function UpdateToast() {
  const { t } = useTranslation(['desktop', 'common']);
  const initialize = useUpdateStore((s) => s.initialize);
  const snapshot = useUpdateStore((s) => s.snapshot);
  const currentVersion = useUpdateStore((s) => s.currentVersion);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const install = useUpdateStore((s) => s.install);
  const openDownloadPage = useUpdateStore((s) => s.openDownloadPage);
  const addToast = useUIStore((s) => s.addToast);

  useEffect(() => initialize(), [initialize]);

  if (!shouldPrompt(snapshot) || snapshot === null) return null;

  const version = statusVersion(snapshot.status);
  if (version === null) return null;

  const canRestart = canRestartToInstall(snapshot);
  const failed = snapshot.status.phase === 'failed';

  const handleLater = () => {
    dismiss();
    // The prompt is gone but the update is not lost, and the user has no way to
    // know that unless they are told once, at the moment they need to know it.
    addToast(t('desktop:update.laterHint'), 'info', 5000);
  };

  let title: string;
  let body: string;
  if (failed) {
    title = t('desktop:update.failed.title');
    body = t('desktop:update.failed.body', { version });
  } else if (canRestart) {
    title = t('desktop:update.ready.title');
    body = t('desktop:update.ready.body', { version });
  } else {
    title = t('desktop:update.available.title', { version });
    body = currentVersion
      ? t('desktop:update.available.bodyWithCurrent', { currentVersion })
      : t('desktop:update.available.body');
  }

  return (
    <div className="fixed bottom-6 left-6 z-[300] animate-slide-up max-w-[calc(calc(100*var(--app-vw))-3rem)]">
      <div className="glass-bubble rounded-2xl p-4 w-[380px] max-w-full">
        <div className="flex items-start gap-3">
          <div
            className={`shrink-0 mt-0.5 w-8 h-8 rounded-full flex items-center justify-center ${
              failed ? 'bg-accent-rose/15 text-accent-rose' : 'bg-accent-primary/15 text-accent-primary'
            }`}
            aria-hidden="true"
          >
            {failed ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0 4-4m-4 4-4-4M4 20h16" />
              </svg>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-txt-primary">{title}</p>
            {/* Deliberately wraps. The previous version truncated this line
                mid-word inside a fixed-width pill. */}
            <p className="text-xs text-txt-secondary mt-1 leading-relaxed">{body}</p>
          </div>

          <button
            onClick={handleLater}
            className="shrink-0 -mt-1 -mr-1 p-1.5 rounded-lg text-txt-tertiary hover:text-txt-secondary hover:bg-white/[0.06] transition-colors"
            aria-label={t('desktop:update.dismiss')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-2 mt-3.5 pl-11">
          {canRestart ? (
            <button
              onClick={install}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-primary hover:bg-accent-primary/80 text-white transition-colors"
            >
              {t('desktop:update.restartNow')}
            </button>
          ) : (
            <button
              onClick={openDownloadPage}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-primary hover:bg-accent-primary/80 text-white transition-colors"
            >
              {t('desktop:update.download')}
            </button>
          )}
          <button
            onClick={handleLater}
            className="px-3 py-1.5 text-xs font-medium rounded-lg text-txt-secondary hover:text-txt-primary hover:bg-white/[0.06] transition-colors"
          >
            {t('desktop:update.later')}
          </button>
        </div>
      </div>
    </div>
  );
}
