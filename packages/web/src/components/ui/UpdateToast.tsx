import { useState, useEffect } from 'react';
import { isElectron } from '../../platform/platform';
import { Trans } from 'react-i18next';
import { translate } from '../../i18n';

interface UpdateError {
  message: string;
  releaseUrl: string;
}

/**
 * Persistent toast shown when an Electron auto-update has been downloaded
 * or when auto-update fails (offers manual download link).
 * Renders nothing in browser environments.
 */
export function UpdateToast() {
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null);
  const [failedUpdate, setFailedUpdate] = useState<UpdateError | null>(null);

  useEffect(() => {
    if (!isElectron() || !window.backspace) return;

    window.backspace.onUpdateDownloaded((info) => {
      setDownloadedVersion(info.version);
      // Auto-download succeeded — clear any previous error state
      setFailedUpdate(null);
    });

    window.backspace.onUpdateError((error) => {
      setFailedUpdate(error);
    });
  }, []);

  // Nothing to show
  if (!downloadedVersion && !failedUpdate) return null;

  // Auto-download succeeded — show restart toast
  if (downloadedVersion) {
    return (
      <div className="fixed bottom-6 left-6 z-[300] animate-slide-up">
        <div className="glass-pill rounded-xl px-4 py-3 flex items-center gap-3 max-w-[340px]">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-txt-primary"><Trans i18nKey="ui.UpdateToast.updateReady">Update ready</Trans></p>
            <p className="text-xs text-txt-secondary truncate">
              <Trans i18nKey="ui.UpdateToast.version">Version</Trans> {downloadedVersion} <Trans i18nKey="ui.UpdateToast.hasBeenDownloaded">has been downloaded</Trans>
            </p>
          </div>
          <button
            onClick={() => window.backspace?.installUpdate()}
            className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-primary hover:bg-accent-primary/80 text-white transition-colors"
          >
            <Trans i18nKey="ui.UpdateToast.restart">Restart</Trans>
          </button>
          <button
            onClick={() => setDownloadedVersion(null)}
            className="shrink-0 p-1 text-txt-tertiary hover:text-txt-secondary transition-colors"
            aria-label={translate("runtime.attributes.UpdateToast.dismiss")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // Auto-download failed — show manual download toast
  return (
    <div className="fixed bottom-6 left-6 z-[300] animate-slide-up">
      <div className="glass-pill rounded-xl px-4 py-3 flex items-center gap-3 max-w-[380px]">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-txt-primary"><Trans i18nKey="ui.UpdateToast.updateFailed">Update failed</Trans></p>
          <p className="text-xs text-txt-secondary truncate">
            <Trans i18nKey="ui.UpdateToast.autoUpdateFailedDownloadManually">Auto-update failed — download manually</Trans>
          </p>
        </div>
        <a
          href={failedUpdate!.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-primary hover:bg-accent-primary/80 text-white transition-colors"
        >
          <Trans i18nKey="ui.UpdateToast.download">Download</Trans>
        </a>
        <button
          onClick={() => setFailedUpdate(null)}
          className="shrink-0 p-1 text-txt-tertiary hover:text-txt-secondary transition-colors"
          aria-label={translate("runtime.attributes.UpdateToast.dismiss2")}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
