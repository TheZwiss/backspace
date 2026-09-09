import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TelemetryPayload } from '@backspace/shared';
import { Modal } from '../ui/Modal';
import { HiButton } from './answers/HiButton';
import { SilenceButton } from './answers/SilenceButton';
import { HelloScene, type SceneMood } from './scene/HelloScene';
import { PayloadPreview } from './PayloadPreview';

interface HelloModalProps {
  open: boolean;
  /** Saves the answer. It rejects when the instance could not store it, and the ask stays open. */
  onAnswer: (enabled: boolean) => Promise<void>;
  /** Closes the ask. The caller decides whether that closing counts as a dismissal. */
  onDismiss: () => void;
  preview: TelemetryPayload | null;
  /** The preview fetch failed, so the preview says so instead of waiting on a request that already ended. */
  previewFailed?: boolean;
}

type Stage = 'ask' | 'saving' | 'yes' | 'no';

/**
 * The button that closes the ask once it has been answered. The two answers
 * themselves are HiButton and SilenceButton, each illustrated as its own
 * scene — a launch and a derelict. They share the row's height and flex basis
 * so the pair still lines up, and both keep a full-contrast label, a visible
 * focus ring and an unreduced hit area. Whatever a label says, it must name
 * the answer it gives: no button here may read as "carry on", because that
 * collects a yes from someone who never answered.
 */
const CLOSE_BUTTON = 'w-full py-2.5 rounded-lg text-sm font-medium transition-colors bg-surface-elevated hover:bg-interactive-selected text-txt-primary';

/**
 * The one-time ask. The answer is saved before anything animates, so the
 * scene only ever celebrates something that is already stored, and a failed
 * save leaves the admin on the ask with an explanation. Nothing closes on its
 * own: every state ends with the admin pressing something.
 */
export function HelloModal({ open, onAnswer, onDismiss, preview, previewFailed = false }: HelloModalProps) {
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
        className="flex flex-col desktop:flex-row gap-6 outline-none"
      >
        <div className="desktop:w-1/2 desktop:flex-shrink-0 self-center w-full aspect-[3/2] rounded-2xl overflow-hidden bg-surface-base">
          <HelloScene mood={mood} />
        </div>
        <div className="desktop:w-1/2 min-w-0 space-y-4 text-sm text-txt-secondary leading-relaxed">
          {stage === 'yes' && (
            <>
              <h2 id={headingId} className="text-lg font-semibold text-txt-primary">{t('yes.title')}</h2>
              <p>{t('yes.body')}</p>
              <button type="button" className={CLOSE_BUTTON} onClick={close}>
                {t('yes.close')}
              </button>
            </>
          )}
          {stage === 'no' && (
            <>
              <h2 id={headingId} className="text-lg font-semibold text-txt-primary">{t('no.title')}</h2>
              <p>{t('no.body')}</p>
              <button type="button" className={CLOSE_BUTTON} onClick={close}>
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
              <PayloadPreview preview={preview} failed={previewFailed} />
              <p>{t('ask.p3')}</p>
              {failed && <p role="alert" className="text-accent-rose">{t('ask.error')}</p>}
              <div className="flex gap-3">
                <HiButton disabled={stage === 'saving'} onClick={() => { void answer(true); }}>
                  {t('ask.yes')}
                </HiButton>
                <SilenceButton disabled={stage === 'saving'} onClick={() => { void answer(false); }}>
                  {t('ask.no')}
                </SilenceButton>
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
