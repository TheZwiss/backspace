import { useState, useEffect } from 'react';
import { isElectron } from '../../platform/platform';

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
            <p className="text-sm font-medium text-txt-primary">Update ready</p>
            <p className="text-xs text-txt-secondary truncate">
              Version {downloadedVersion} has been downloaded
            </p>
          </div>
          <button
            onClick={() => window.backspace?.installUpdate()}
            className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-primary hover:bg-accent-primary/80 text-white transition-colors"
          >
            Restart
          </button>
          <button
            onClick={() => setDownloadedVersion(null)}
            className="shrink-0 p-1 text-txt-tertiary hover:text-txt-secondary transition-colors"
            aria-label="Dismiss"
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
          <p className="text-sm font-medium text-txt-primary">Update available</p>
          <p className="text-xs text-txt-secondary truncate">
            Auto-install failed — download manually
          </p>
        </div>
        <a
          href={failedUpdate!.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-primary hover:bg-accent-primary/80 text-white transition-colors"
        >
          Download
        </a>
        <button
          onClick={() => setFailedUpdate(null)}
          className="shrink-0 p-1 text-txt-tertiary hover:text-txt-secondary transition-colors"
          aria-label="Dismiss"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
