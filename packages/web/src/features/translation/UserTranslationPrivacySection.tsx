import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from '@backspace/shared/src/translation';
import { api } from '../../api/client';
import { describeError } from '../../i18n/errors';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { Toggle } from '../../components/ui/Toggle';
import { LANGUAGE_LABELS } from './TranslationConsentModal';
import {
  clearOriginMemoryEntries,
  ensureOriginTranslationStatus,
  statusScopeKey,
  useTranslationStore,
} from './translationStore';

export function UserTranslationPrivacySection() {
  const { t } = useTranslation(['translation', 'common']);
  const userId = useAuthStore((s) => s.user?.id ?? '');
  const addToast = useUIStore((s) => s.addToast);
  const scopeKey = userId ? statusScopeKey(userId, '') : '';
  const status = useTranslationStore((s) => (scopeKey ? s.statuses[scopeKey] : undefined));

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    void ensureOriginTranslationStatus('', true);
  }, [userId]);

  if (!status || !status.enabled || !status.provider) {
    return null;
  }

  const updatePrefs = async (patch: {
    consent?: boolean;
    targetLanguage?: TranslationLanguage;
    showOriginal?: boolean;
  }) => {
    if (!userId || !status.provider) return;
    setBusy(true);
    try {
      const updated = await api.translation.updatePreferences({
        ...patch,
        ...(patch.consent === true ? { providerFingerprint: status.provider.fingerprint } : {}),
      });
      useTranslationStore.setState((s) => ({
        statuses: { ...s.statuses, [scopeKey]: updated },
      }));
      if (patch.consent === false) {
        clearOriginMemoryEntries('');
      }
    } catch (error) {
      addToast(describeError(error), 'warning', 4000);
    } finally {
      setBusy(false);
    }
  };

  const handleClearCache = async () => {
    setBusy(true);
    try {
      await api.translation.clearCache();
      clearOriginMemoryEntries('');
      addToast(t('translation:privacySection.cacheCleared'), 'info', 3000);
    } catch (error) {
      addToast(describeError(error), 'warning', 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
        {t('translation:privacySection.title')}
      </div>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-txt-primary">{t('translation:privacySection.consentLabel')}</div>
            <div className="text-xs text-txt-tertiary mt-0.5 leading-relaxed">
              {t('translation:privacySection.consentDescription', {
                provider: status.provider.label,
                host: status.provider.host,
              })}
            </div>
          </div>
          <Toggle
            ariaLabel={t('translation:privacySection.consentLabel')}
            enabled={status.preferences.consented}
            disabled={busy}
            onChange={(next) => void updatePrefs({ consent: next })}
          />
        </div>

        <div className="border-t border-white/[0.06] pt-3 grid grid-cols-1 desktop:grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-txt-secondary">
            {t('translation:targetLanguage')}
            <select
              className="input-standard mt-1.5 w-full"
              value={status.preferences.targetLanguage}
              disabled={busy}
              onChange={(e) => void updatePrefs({ targetLanguage: e.target.value as TranslationLanguage })}
            >
              {TRANSLATION_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {LANGUAGE_LABELS[code]}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="min-w-0">
              <div className="text-xs font-medium text-txt-secondary">{t('translation:showOriginal')}</div>
              <div className="text-[11px] text-txt-tertiary mt-0.5">{t('translation:showOriginalHelp')}</div>
            </div>
            <Toggle
              ariaLabel={t('translation:showOriginal')}
              enabled={status.preferences.showOriginal}
              disabled={busy}
              onChange={(next) => void updatePrefs({ showOriginal: next })}
            />
          </div>
        </div>

        <div className="border-t border-white/[0.06] pt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-txt-tertiary">{t('translation:privacySection.cacheHint')}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleClearCache()}
            className="shrink-0 px-3 py-1.5 rounded-lg text-xs text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
          >
            {t('translation:privacySection.clearCache')}
          </button>
        </div>
      </div>
    </div>
  );
}
