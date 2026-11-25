import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from '@backspace/shared/src/translation';
import { Modal } from '../../components/ui/Modal';
import { Toggle } from '../../components/ui/Toggle';
import {
  confirmFirstTransferAndTranslate,
  dismissConsentPrompt,
  useTranslationStore,
} from './translationStore';

export const LANGUAGE_LABELS: Record<TranslationLanguage, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
};

export function TranslationConsentModal() {
  const { t } = useTranslation(['translation', 'common']);
  const pending = useTranslationStore((s) => s.pendingConsent);

  const [targetLanguage, setTargetLanguage] = useState<TranslationLanguage>('en');
  const [showOriginal, setShowOriginal] = useState(true);

  useEffect(() => {
    if (!pending) return;
    setTargetLanguage(pending.targetLanguage);
    setShowOriginal(pending.showOriginal);
  }, [pending]);

  if (!pending) return null;

  return (
    <Modal isOpen onClose={dismissConsentPrompt} title={t('translation:consentModal.title')}>
      <div className="space-y-4">
        <p className="text-sm text-txt-secondary leading-relaxed">
          {t('translation:consentModal.disclosure', {
            provider: pending.provider.label,
            host: pending.provider.host,
          })}
        </p>

        <ul className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-3 pl-7 list-disc text-xs text-txt-tertiary space-y-1.5 leading-relaxed">
          <li>{t('translation:consentModal.minimalData')}</li>
          <li>{t('translation:consentModal.revokeAnytime')}</li>
        </ul>

        <div className="space-y-3 pt-1">
          <label className="block text-xs font-medium text-txt-secondary">
            {t('translation:targetLanguage')}
            <select
              className="input-standard mt-1.5 w-full"
              value={targetLanguage}
              disabled={pending.submitting}
              onChange={(e) => setTargetLanguage(e.target.value as TranslationLanguage)}
            >
              {TRANSLATION_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {LANGUAGE_LABELS[code]}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center justify-between gap-4 py-1">
            <div className="min-w-0">
              <div className="text-sm text-txt-primary">{t('translation:showOriginal')}</div>
              <div className="text-xs text-txt-tertiary mt-0.5">{t('translation:showOriginalHelp')}</div>
            </div>
            <Toggle
              ariaLabel={t('translation:showOriginal')}
              enabled={showOriginal}
              disabled={pending.submitting}
              onChange={setShowOriginal}
            />
          </div>
        </div>

        {pending.error && (
          <div role="alert" className="rounded-lg bg-accent-rose/10 border border-accent-rose/20 p-2.5 text-xs text-txt-danger">
            {pending.error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            disabled={pending.submitting}
            onClick={dismissConsentPrompt}
            className="px-3.5 py-1.5 rounded-lg text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            disabled={pending.submitting}
            onClick={() => void confirmFirstTransferAndTranslate({ targetLanguage, showOriginal })}
            className="px-4 py-1.5 rounded-lg text-sm font-medium text-white bg-accent-primary hover:bg-accent-primary-hover transition-colors disabled:opacity-50"
          >
            {pending.submitting ? t('translation:translating') : t('translation:consentModal.confirm')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
