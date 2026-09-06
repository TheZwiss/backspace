import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TelemetryPayload } from '@backspace/shared';
import { Modal } from '../ui/Modal';
import { HelloScene, type SceneMood } from './scene/HelloScene';
import { PayloadPreview } from './PayloadPreview';

interface HelloModalProps {
  open: boolean;
  /** Saves the answer. It rejects when the instance could not store it, and the ask stays open. */
  onAnswer: (enabled: boolean) => Promise<void>;
  /** Closes the ask. The caller decides whether that closing counts as a dismissal. */
  onDismiss: () => void;
  preview: TelemetryPayload | null;
}

type Stage = 'ask' | 'saving' | 'yes' | 'no';

/**
 * One class string for every button in the ask. The two answers must not
 * differ in size, weight or colour, so neither of them is the nudged one.
 */
const BUTTON = 'flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 bg-surface-elevated hover:bg-interactive-selected text-txt-primary';

/**
 * The one-time ask. The answer is saved before anything animates, so the
 * scene only ever celebrates something that is already stored, and a failed
 * save leaves the admin on the ask with an explanation. Nothing closes on its
 * own: every state ends with the admin pressing something.
 */
export function HelloModal({ open, onAnswer, onDismiss, preview }: HelloModalProps) {
  const { t } = useTranslation('telemetry');
  const [stage, setStage] = useState<Stage>('ask');
  const [failed, setFailed] = useState(false);
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setStage('ask');
    setFailed(false);
    // The ask arrives unprompted, so it takes focus: screen readers announce it
    // and the keyboard reaches its controls without a click first.
    dialogRef.current?.focus();
  }, [open]);

  // Closing while the answer is in flight would snooze an ask that is about to
  // be answered, so every closing path waits for the save to land.
  const close = useCallback(() => {
    if (stage === 'saving') return;
    onDismiss();
  }, [stage, onDismiss]);

  const answer = async (enabled: boolean): Promise<void> => {
    setStage('saving');
    setFailed(false);
    try {
      await onAnswer(enabled);
      setStage(enabled ? 'yes' : 'no');
    } catch {
      setFailed(true);
      setStage('ask');
    }
  };

  const mood: SceneMood = stage === 'yes' ? 'happy' : stage === 'no' ? 'farewell' : 'idle';
  const asking = stage === 'ask' || stage === 'saving';

  return (
    <Modal isOpen={open} onClose={close} maxWidth="max-w-3xl" mobileStyle="fullscreen">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="flex flex-col md:flex-row gap-6 outline-none"
      >
        <div className="md:w-1/2 md:flex-shrink-0 self-center w-full aspect-[3/2] rounded-2xl overflow-hidden bg-surface-base">
          <HelloScene mood={mood} />
        </div>
        <div className="md:w-1/2 min-w-0 space-y-4 text-sm text-txt-secondary leading-relaxed">
          {stage === 'yes' && (
            <>
              <h2 id={headingId} className="text-lg font-semibold text-txt-primary">{t('yes.title')}</h2>
              <p>{t('yes.body')}</p>
              <button type="button" className={`${BUTTON} w-full`} onClick={close}>
                {t('yes.close')}
              </button>
            </>
          )}
          {stage === 'no' && (
            <>
              <h2 id={headingId} className="text-lg font-semibold text-txt-primary">{t('no.title')}</h2>
              <p>{t('no.body')}</p>
              <button type="button" className={`${BUTTON} w-full`} onClick={close}>
                {t('no.close')}
              </button>
            </>
          )}
          {asking && (
            <>
              <h2 id={headingId} className="text-lg font-semibold text-txt-primary">{t('ask.title')}</h2>
              <p>{t('ask.p1')}</p>
              <p>{t('ask.p2')}</p>
              <p className="text-txt-primary">{t('ask.previewLead')}</p>
              <PayloadPreview preview={preview} />
              <p>{t('ask.p3')}</p>
              {failed && <p role="alert" className="text-accent-rose">{t('ask.error')}</p>}
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={stage === 'saving'}
                  className={BUTTON}
                  onClick={() => { void answer(true); }}
                >
                  {t('ask.yes')}
                </button>
                <button
                  type="button"
                  disabled={stage === 'saving'}
                  className={BUTTON}
                  onClick={() => { void answer(false); }}
                >
                  {t('ask.no')}
                </button>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-txt-tertiary">
                <span aria-live="polite">{stage === 'saving' ? t('ask.saving') : ''}</span>
                <button
                  type="button"
                  disabled={stage === 'saving'}
                  className="underline hover:text-txt-secondary transition-colors disabled:opacity-50"
                  onClick={close}
                >
                  {t('ask.later')}
                </button>
              </div>
              <p className="text-xs text-txt-tertiary">{t('ask.footnote')}</p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
