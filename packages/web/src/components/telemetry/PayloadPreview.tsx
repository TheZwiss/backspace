import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TelemetryPayload } from '@backspace/shared';

interface PayloadPreviewProps {
  /** The payload the server would send today, or null while it is still being fetched. */
  preview: TelemetryPayload | null;
  /**
   * Start expanded. The ask keeps it folded away so the modal stays short; the
   * settings section is a page about the ping, so there it opens straight away.
   */
  defaultOpen?: boolean;
  /**
   * The preview fetch failed. Without this the collapsed body sat on
   * "Putting the message together" for the life of the modal, which reads as a
   * request still in flight rather than one that already failed.
   */
  failed?: boolean;
}

/**
 * The real ping, collapsed by default. Nothing is composed here: the JSON is
 * the response of the preview endpoint, so what the admin reads is what the
 * instance would send.
 */
export function PayloadPreview({ preview, defaultOpen = false, failed = false }: PayloadPreviewProps) {
  const { t } = useTranslation('telemetry');
  const [open, setOpen] = useState(defaultOpen);
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
            <p className="text-xs text-txt-tertiary">
              {failed ? t('ask.previewError') : t('ask.previewLoading')}
            </p>
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
