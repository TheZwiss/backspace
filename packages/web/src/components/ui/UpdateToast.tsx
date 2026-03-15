import React, { useState, useEffect } from 'react';
import { isElectron } from '../../platform/platform';

/**
 * Persistent toast shown when an Electron auto-update has been downloaded.
 * Renders nothing in browser environments.
 */
export function UpdateToast() {
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron() || !window.backspace) return;

    window.backspace.onUpdateDownloaded((info) => {
      setDownloadedVersion(info.version);
    });
  }, []);

  if (!downloadedVersion) return null;

  const handleRestart = () => {
    window.backspace?.installUpdate();
  };

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
          onClick={handleRestart}
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
