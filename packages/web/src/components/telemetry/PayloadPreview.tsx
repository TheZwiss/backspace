import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TelemetryPayload } from '@backspace/shared';

interface PayloadPreviewProps {
  /** The payload the server would send today, or null while it is still being fetched. */
  preview: TelemetryPayload | null;
}

/**
 * The real ping, collapsed by default. Nothing is composed here: the JSON is
 * the response of the preview endpoint, so what the admin reads is what the
 * instance would send.
 */
export function PayloadPreview({ preview }: PayloadPreviewProps) {
  const { t } = useTranslation('telemetry');
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  return (
    <div>
      <button
        type="button"
        className="text-xs font-medium text-txt-link hover:underline"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? t('ask.previewToggleHide') : t('ask.previewToggleShow')}
      </button>
      {open && (
        <div id={bodyId} className="mt-2">
          {preview === null ? (
            <p className="text-xs text-txt-tertiary">{t('ask.previewLoading')}</p>
          ) : (
            <pre className="bg-surface-input rounded-lg font-mono text-xs p-3 overflow-x-auto max-h-64 text-txt-secondary">
              {JSON.stringify(preview, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
