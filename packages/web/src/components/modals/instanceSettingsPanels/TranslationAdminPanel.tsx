import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdminTranslationProviderView, TranslationProtocol } from '@backspace/shared/src/translation';
import { api } from '../../../api/client';
import { describeError } from '../../../i18n/errors';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';

const PROTOCOL_DEFAULTS: Record<TranslationProtocol, { label: string; baseUrl: string }> = {
  'openai-chat': { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  'openai-responses': { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
};

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function TranslationAdminPanel() {
  const { t } = useTranslation(['translation', 'common']);
  const addToast = useUIStore((s) => s.addToast);

  const [view, setView] = useState<AdminTranslationProviderView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [providerLabel, setProviderLabel] = useState('OpenAI');
  const [protocol, setProtocol] = useState<TranslationProtocol>('openai-chat');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  const [models, setModels] = useState<string[]>([]);
  const [busyAction, setBusyAction] = useState<'save' | 'models' | 'test' | 'delete' | 'cache' | null>(null);
  const [testResult, setTestResult] = useState<{ latencyMs: number; sample: string } | null>(null);
  const [formError, setFormError] = useState('');

  const applyView = (next: AdminTranslationProviderView) => {
    setView(next);
    setEnabled(next.enabled);
    setProviderLabel(next.providerLabel);
    setProtocol(next.protocol);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setApiKey('');
  };

  const loadConfig = useCallback(async () => {
    setLoadError('');
    try {
      const data = await api.admin.translation.get();
      applyView(data);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  if (!view) {
    if (loadError) {
      return (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-txt-primary">{t('translation:admin.title')}</h2>
          <div className="rounded-lg bg-accent-rose/10 border border-accent-rose/20 p-3.5 text-sm text-txt-secondary">
            {loadError}
          </div>
          <button
            type="button"
            onClick={() => void loadConfig()}
            className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors"
          >
            {t('common:actions.tryAgain')}
          </button>
        </div>
      );
    }
    return <div className="text-sm text-txt-tertiary">{t('common:states.loadingSettings')}</div>;
  }

  const endpointUnchanged =
    view.configured && view.protocol === protocol && view.baseUrl === stripTrailingSlashes(baseUrl.trim());

  const handleProtocolChange = (next: TranslationProtocol) => {
    const prevDefault = PROTOCOL_DEFAULTS[protocol];
    const nextDefault = PROTOCOL_DEFAULTS[next];
    setProtocol(next);
    if (!baseUrl.trim() || baseUrl === prevDefault.baseUrl) {
      setBaseUrl(nextDefault.baseUrl);
    }
    if (!providerLabel.trim() || providerLabel === prevDefault.label) {
      setProviderLabel(nextDefault.label);
    }
    setModels([]);
    setTestResult(null);
  };

  const handleSave = async () => {
    setBusyAction('save');
    setFormError('');
    setTestResult(null);
    try {
      const updated = await api.admin.translation.save({
        enabled,
        providerLabel,
        protocol,
        baseUrl,
        model,
        apiKey: apiKey.trim() || undefined,
      });
      applyView(updated);
      addToast(t('translation:admin.saved'), 'info', 3000);
    } catch (err) {
      setFormError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleFetchModels = async () => {
    setBusyAction('models');
    setFormError('');
    try {
      const res = await api.admin.translation.listModels({
        protocol,
        baseUrl,
        apiKey: apiKey.trim() || undefined,
      });
      setModels(res.models);
      if (res.models.length > 0 && !model.trim()) {
        setModel(res.models[0]!);
      }
    } catch (err) {
      setFormError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleTest = async () => {
    setBusyAction('test');
    setFormError('');
    setTestResult(null);
    try {
      const res = await api.admin.translation.test({
        protocol,
        baseUrl,
        model,
        apiKey: apiKey.trim() || undefined,
      });
      setTestResult(res);
    } catch (err) {
      setFormError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleClearCache = async () => {
    setBusyAction('cache');
    setFormError('');
    try {
      await api.admin.translation.clearCache();
      addToast(t('translation:admin.cacheCleared'), 'info', 3000);
    } catch (err) {
      setFormError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRemove = async () => {
    setBusyAction('delete');
    setFormError('');
    setTestResult(null);
    try {
      await api.admin.translation.remove();
      await loadConfig();
      addToast(t('translation:admin.removed'), 'info', 3000);
    } catch (err) {
      setFormError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary">{t('translation:admin.title')}</h2>
        <p className="text-xs text-txt-tertiary mt-1 leading-relaxed">{t('translation:admin.description')}</p>
      </div>

      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-txt-primary">{t('translation:admin.enableLabel')}</div>
          <div className="text-xs text-txt-tertiary mt-0.5">{t('translation:admin.enableDescription')}</div>
        </div>
        <Toggle
          ariaLabel={t('translation:admin.enableLabel')}
          enabled={enabled}
          disabled={busyAction !== null}
          onChange={setEnabled}
        />
      </div>

      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-4">
        <div className="grid grid-cols-1 desktop:grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-txt-secondary">
            {t('translation:admin.providerLabel')}
            <input
              type="text"
              className="input-standard mt-1.5 w-full"
              value={providerLabel}
              maxLength={80}
              onChange={(e) => setProviderLabel(e.target.value)}
            />
          </label>

          <label className="block text-xs font-medium text-txt-secondary">
            {t('translation:admin.protocol')}
            <select
              className="input-standard mt-1.5 w-full"
              value={protocol}
              onChange={(e) => handleProtocolChange(e.target.value as TranslationProtocol)}
            >
              <option value="openai-chat">{t('translation:admin.protocols.openaiChat')}</option>
              <option value="openai-responses">{t('translation:admin.protocols.openaiResponses')}</option>
              <option value="anthropic">{t('translation:admin.protocols.anthropic')}</option>
              <option value="gemini">{t('translation:admin.protocols.gemini')}</option>
            </select>
          </label>
        </div>

        <label className="block text-xs font-medium text-txt-secondary">
          {t('translation:admin.baseUrl')}
          <input
            type="url"
            className="input-standard mt-1.5 w-full"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <span className="block text-[11px] text-txt-tertiary mt-1">{t('translation:admin.baseUrlHelp')}</span>
        </label>

        <label className="block text-xs font-medium text-txt-secondary">
          {t('translation:admin.apiKey')}
          <input
            type="password"
            autoComplete="off"
            className="input-standard mt-1.5 w-full"
            value={apiKey}
            placeholder={
              view.hasApiKey && endpointUnchanged
                ? t('translation:admin.keyStoredPlaceholder')
                : t('translation:admin.keyRequiredPlaceholder')
            }
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        <div className="space-y-2">
          <div className="flex items-end gap-2">
            <label className="block flex-1 text-xs font-medium text-txt-secondary">
              {t('translation:admin.model')}
              <input
                type="text"
                className="input-standard mt-1.5 w-full"
                value={model}
                placeholder={t('translation:admin.modelPlaceholder')}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleFetchModels()}
              className="px-3 py-2 rounded-lg text-xs font-medium text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
            >
              {busyAction === 'models' ? t('translation:admin.fetchingModels') : t('translation:admin.fetchModels')}
            </button>
          </div>

          {models.length > 0 && (
            <select
              className="input-standard w-full text-xs"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
        </div>

        {formError && (
          <div role="alert" className="rounded-lg bg-accent-rose/10 border border-accent-rose/20 p-2.5 text-xs text-txt-danger">
            {formError}
          </div>
        )}

        {testResult && (
          <div role="status" className="rounded-lg bg-accent-mint/10 border border-accent-mint/20 p-2.5 text-xs text-accent-mint">
            {t('translation:admin.testPassed', { ms: testResult.latencyMs, sample: testResult.sample })}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-white/[0.06]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleTest()}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
            >
              {busyAction === 'test' ? t('translation:admin.testing') : t('translation:admin.testConnection')}
            </button>
            {view.configured && (
              <>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleClearCache()}
                  className="px-3 py-1.5 rounded-lg text-xs text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
                >
                  {t('translation:admin.clearCache')}
                </button>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleRemove()}
                  className="px-3 py-1.5 rounded-lg text-xs text-txt-danger hover:bg-accent-rose/10 transition-colors disabled:opacity-50"
                >
                  {t('translation:admin.removeProvider')}
                </button>
              </>
            )}
          </div>

          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => void handleSave()}
            className="px-4 py-1.5 rounded-lg text-sm font-medium text-white bg-accent-primary hover:bg-accent-primary-hover transition-colors disabled:opacity-50"
          >
            {busyAction === 'save' ? t('common:states.saving') : t('translation:admin.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
